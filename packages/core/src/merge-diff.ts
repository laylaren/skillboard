import { join, relative } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { scan } from './scanner.js';
import { analyzeMerge, type MergeCandidate, type MergePlanItem } from './merge-plan.js';

export type FileDiffStatus = 'same' | 'changed' | 'only-in-a' | 'only-in-b';

export interface FileDiffEntry {
  /** Path relative to the skill root. */
  path: string;
  status: FileDiffStatus;
  /** For 'changed' entries on text files: unified diff body. Limited to ~2000 lines. */
  unifiedDiff?: string;
  /** Hint that the file is binary — we don't try to diff it. */
  binary?: boolean;
}

export interface MergeDiff {
  plan: MergePlanItem;
  /** Candidate A and B are the first two distinct physical files. */
  a: MergeCandidate;
  b: MergeCandidate;
  /** Per-file status across both trees, sorted by path. */
  files: FileDiffEntry[];
  /** Quick rollup. */
  summary: {
    same: number;
    changed: number;
    onlyInA: number;
    onlyInB: number;
  };
}

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.html',
  '.css',
  '.toml',
  '.sh',
  '.mjs',
  '.cjs',
  '.xml',
  '.rb',
  '.go',
  '.rs',
]);

async function listFiles(root: string): Promise<Map<string, { abs: string; size: number }>> {
  const out = new Map<string, { abs: string; size: number }>();
  async function walk(dir: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (d.name === '.DS_Store' || d.name === '.git') continue;
      const abs = join(dir, d.name);
      const s = await stat(abs).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) {
        await walk(abs);
      } else if (s.isFile()) {
        out.set(relative(root, abs), { abs, size: s.size });
      }
    }
  }
  await walk(root);
  return out;
}

function fileSha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function looksBinary(buf: Buffer): boolean {
  // Quick heuristic — anything with a NUL byte in the first 4 KB is "binary".
  const end = Math.min(buf.length, 4096);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

function isTextByExt(p: string): boolean {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(p.slice(dot).toLowerCase());
}

/**
 * Unified diff using the classic LCS algorithm — simple, no dependency.
 * Lines are 1-indexed. Output is plain unified-diff format.
 *
 * We cap input size and diff length to keep the wire payload reasonable. A
 * SKILL.md that's 100 KB shouldn't blow up the response.
 */
export function unifiedDiff(
  a: string,
  b: string,
  pathA: string,
  pathB: string,
  contextLines = 3,
): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  // Cap to 8000 lines per side — if either side is bigger we just say "too large".
  if (aLines.length > 8000 || bLines.length > 8000) {
    return `--- ${pathA}\n+++ ${pathB}\n@@ file too large to diff (${aLines.length} vs ${bLines.length} lines) @@\n`;
  }

  // LCS table over lines.
  const m = aLines.length;
  const n = bLines.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) lcs[i]![j] = lcs[i + 1]![j + 1]! + 1;
      else lcs[i]![j] = Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  type Op = { kind: ' ' | '-' | '+'; line: string; ai?: number; bi?: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      ops.push({ kind: ' ', line: aLines[i]!, ai: i, bi: j });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: '-', line: aLines[i]!, ai: i });
      i++;
    } else {
      ops.push({ kind: '+', line: bLines[j]!, bi: j });
      j++;
    }
  }
  while (i < m) ops.push({ kind: '-', line: aLines[i]!, ai: i++ });
  while (j < n) ops.push({ kind: '+', line: bLines[j]!, bi: j++ });

  // Group into hunks around non-' ' regions with context lines.
  type Hunk = { aStart: number; bStart: number; lines: Op[] };
  const hunks: Hunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.kind === ' ') {
      k++;
      continue;
    }
    // Pull back contextLines of preceding ' ' ops.
    let start = k;
    let before = 0;
    while (start > 0 && ops[start - 1]!.kind === ' ' && before < contextLines) {
      start--;
      before++;
    }
    // Extend forward until we have contextLines ' ' ops with no more changes after.
    let end = k;
    while (end < ops.length) {
      if (ops[end]!.kind !== ' ') {
        end++;
        continue;
      }
      // count following context
      let after = 0;
      let probe = end;
      while (probe < ops.length && ops[probe]!.kind === ' ' && after < contextLines) {
        probe++;
        after++;
      }
      // If the next non-' ' after `after` ' ' ops is still within reach, keep going.
      if (probe < ops.length && ops[probe]!.kind !== ' ' && after < contextLines * 2) {
        end = probe;
      } else {
        end += after;
        break;
      }
    }
    if (end > ops.length) end = ops.length;

    const slice = ops.slice(start, end);
    const aStart = slice.find((o) => o.ai !== undefined)?.ai ?? -1;
    const bStart = slice.find((o) => o.bi !== undefined)?.bi ?? -1;
    hunks.push({ aStart: aStart < 0 ? 0 : aStart, bStart: bStart < 0 ? 0 : bStart, lines: slice });
    k = end;
  }

  let out = `--- ${pathA}\n+++ ${pathB}\n`;
  let totalEmitted = 0;
  for (const h of hunks) {
    const aCount = h.lines.filter((o) => o.kind !== '+').length;
    const bCount = h.lines.filter((o) => o.kind !== '-').length;
    out += `@@ -${h.aStart + 1},${aCount} +${h.bStart + 1},${bCount} @@\n`;
    for (const o of h.lines) {
      out += o.kind + o.line + '\n';
      totalEmitted++;
      if (totalEmitted > 2000) {
        out += `[diff truncated at 2000 lines]\n`;
        return out;
      }
    }
  }
  return out;
}

export async function getMergeDiff(
  name: string,
  opts: { canonicalRoot?: string; home?: string } = {},
): Promise<MergeDiff> {
  const home = opts.home ?? homedir();
  const canonical = opts.canonicalRoot ?? `${home}/.agents/skills`;
  const result = await scan({ home });
  const plans = await analyzeMerge(result.skills, canonical);
  const plan = plans.find((p) => p.name === name);
  if (!plan) throw new Error(`no conflict found for "${name}"`);
  if (plan.candidates.length < 2) throw new Error(`"${name}" has only one distinct file — nothing to diff`);

  // Default A = canonical winner if present, else first candidate.
  const a = plan.canonicalWinner ?? plan.candidates[0]!;
  const b = plan.candidates.find((c) => c !== a) ?? plan.candidates[1]!;

  const aFiles = await listFiles(a.realPath);
  const bFiles = await listFiles(b.realPath);

  const allPaths = new Set<string>();
  for (const k of aFiles.keys()) allPaths.add(k);
  for (const k of bFiles.keys()) allPaths.add(k);
  const sorted = [...allPaths].sort();

  const files: FileDiffEntry[] = [];
  const summary = { same: 0, changed: 0, onlyInA: 0, onlyInB: 0 };

  for (const rel of sorted) {
    const inA = aFiles.get(rel);
    const inB = bFiles.get(rel);
    if (inA && !inB) {
      files.push({ path: rel, status: 'only-in-a' });
      summary.onlyInA++;
      continue;
    }
    if (!inA && inB) {
      files.push({ path: rel, status: 'only-in-b' });
      summary.onlyInB++;
      continue;
    }
    if (!inA || !inB) continue; // unreachable, satisfy ts

    // Compare contents.
    const bufA = await readFile(inA.abs).catch(() => Buffer.alloc(0));
    const bufB = await readFile(inB.abs).catch(() => Buffer.alloc(0));
    if (fileSha(bufA) === fileSha(bufB)) {
      files.push({ path: rel, status: 'same' });
      summary.same++;
      continue;
    }
    summary.changed++;
    const isBin = looksBinary(bufA) || looksBinary(bufB) || !isTextByExt(rel);
    if (isBin) {
      files.push({ path: rel, status: 'changed', binary: true });
    } else {
      files.push({
        path: rel,
        status: 'changed',
        unifiedDiff: unifiedDiff(bufA.toString('utf8'), bufB.toString('utf8'), `a/${rel}`, `b/${rel}`),
      });
    }
  }

  return { plan, a, b, files, summary };
}
