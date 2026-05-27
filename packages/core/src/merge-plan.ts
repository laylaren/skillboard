import { join, sep } from 'node:path';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Skill } from './types.js';
import { groupByName, isRealConflict } from './scanner.js';

export interface MergeCandidate {
  /** Physical location of this candidate (deduped realPath). */
  realPath: string;
  /** Latest mtime found anywhere in the candidate's tree. */
  mtime: Date;
  /** Total file bytes (excluding directory overhead). */
  sizeBytes: number;
  /** Number of files in the tree. */
  fileCount: number;
  /**
   * Recursive content hash. Two candidates with the same `dirSha` are
   * byte-identical content-wise (filenames + file contents, in sorted order).
   */
  dirSha: string;
  /** All the skill entries (potentially across agents/scopes) pointing here. */
  members: Skill[];
  /** True if `realPath` lives under the canonical root. */
  inCanonicalRoot: boolean;
}

export interface MergePlanItem {
  name: string;
  /** One entry per distinct physical file. */
  candidates: MergeCandidate[];
  /** True when every candidate's `dirSha` matches — safe to silently merge. */
  contentsIdentical: boolean;
  /** Strategy: newest mtime wins. */
  newestWinner: MergeCandidate | null;
  /** Strategy: only candidate inside the canonical root wins. null if 0 or >1 match. */
  canonicalWinner: MergeCandidate | null;
  /** True when at least one candidate lives in canonical root. */
  hasCanonicalCandidate: boolean;
  /**
   * Recommendation under the "safe hybrid" strategy (canonical + content check):
   *   - 'silent-merge'    : contents identical AND exactly one canonical candidate → auto-merge
   *   - 'diff-then-pick'  : multiple candidates, contents differ → user must review
   *   - 'no-canonical'    : no candidate in canonical root → fall back to manual pick
   *   - 'ambiguous-canonical' : multiple candidates already in canonical root → user picks
   */
  safeHybridAction:
    | 'silent-merge'
    | 'diff-then-pick'
    | 'no-canonical'
    | 'ambiguous-canonical';
}

async function hashDir(absPath: string): Promise<{
  sha: string;
  sizeBytes: number;
  fileCount: number;
  latestMtime: Date;
}> {
  const hash = createHash('sha256');
  let totalSize = 0;
  let fileCount = 0;
  let latest = new Date(0);

  async function walk(p: string, rel: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort deterministically so the hash is stable across runs.
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (d.name === '.DS_Store') continue;
      const full = join(p, d.name);
      const relChild = rel ? `${rel}/${d.name}` : d.name;
      const s = await stat(full).catch(() => null);
      if (!s) continue;
      if (s.mtime > latest) latest = s.mtime;
      if (s.isDirectory()) {
        hash.update(`D:${relChild}\n`);
        await walk(full, relChild);
      } else if (s.isFile()) {
        fileCount += 1;
        totalSize += s.size;
        hash.update(`F:${relChild}:`);
        const buf = await readFile(full).catch(() => Buffer.alloc(0));
        hash.update(buf);
        hash.update('\n');
      }
    }
  }

  await walk(absPath, '');
  return {
    sha: hash.digest('hex').slice(0, 16),
    sizeBytes: totalSize,
    fileCount,
    latestMtime: latest,
  };
}

function isUnder(child: string, parent: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(p);
}

/**
 * Build a dry-run merge plan for every name that has 2+ distinct physical files.
 * Pure analysis — never writes.
 */
export async function analyzeMerge(
  skills: Skill[],
  canonicalRoot: string,
): Promise<MergePlanItem[]> {
  // Canonicalize the canonical root once. Skill `realPath` is already canonical
  // (came from fs.realpath in the scanner), so without this both sides could
  // disagree on symlink-y paths like /tmp vs /private/tmp on macOS.
  const canonicalReal = await realpath(canonicalRoot).catch(() => canonicalRoot);
  const groups = groupByName(skills).filter(isRealConflict);
  const out: MergePlanItem[] = [];

  for (const group of groups) {
    // Bucket entries by physical path.
    const byReal = new Map<string, Skill[]>();
    for (const m of group.members) {
      const arr = byReal.get(m.realPath) ?? [];
      arr.push(m);
      byReal.set(m.realPath, arr);
    }

    const candidates: MergeCandidate[] = [];
    for (const [realPath, members] of byReal) {
      const { sha, sizeBytes, fileCount, latestMtime } = await hashDir(realPath);
      candidates.push({
        realPath,
        mtime: latestMtime,
        sizeBytes,
        fileCount,
        dirSha: sha,
        members,
        inCanonicalRoot: isUnder(realPath, canonicalReal),
      });
    }

    const shas = new Set(candidates.map((c) => c.dirSha));
    const contentsIdentical = shas.size === 1;

    const newestWinner =
      candidates.reduce<MergeCandidate | null>(
        (acc, c) => (!acc || c.mtime > acc.mtime ? c : acc),
        null,
      ) ?? null;

    const canonicalCands = candidates.filter((c) => c.inCanonicalRoot);
    const canonicalWinner = canonicalCands.length === 1 ? canonicalCands[0]! : null;

    let safeHybridAction: MergePlanItem['safeHybridAction'];
    if (canonicalCands.length === 0) {
      safeHybridAction = 'no-canonical';
    } else if (canonicalCands.length > 1) {
      safeHybridAction = 'ambiguous-canonical';
    } else if (contentsIdentical) {
      safeHybridAction = 'silent-merge';
    } else {
      safeHybridAction = 'diff-then-pick';
    }

    out.push({
      name: group.name,
      candidates,
      contentsIdentical,
      newestWinner,
      canonicalWinner,
      hasCanonicalCandidate: canonicalCands.length >= 1,
      safeHybridAction,
    });
  }

  return out;
}
