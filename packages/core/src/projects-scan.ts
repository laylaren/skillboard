import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { readdir, stat } from 'node:fs/promises';

export interface ProjectCandidate {
  /** Absolute path to the project root. */
  path: string;
  /** Friendly basename, suitable for display. */
  basename: string;
  /** Which agents have skills here (used by the UI to render tag chips). */
  hasClaudeCode: boolean;
  hasCursor: boolean;
  hasCodex: boolean;
}

export interface ScanCandidatesOptions {
  /** Search root. Default: the user's home dir. */
  home?: string;
  /** Maximum directory depth to walk under `home`. Default 5. */
  maxDepth?: number;
  /** Paths already confirmed; never returned as candidates. */
  confirmedPaths?: ReadonlySet<string>;
  /** Paths previously dismissed; never returned as candidates. */
  dismissedPaths?: ReadonlySet<string>;
}

const PRUNE_DIRS = new Set([
  // Build artefacts & vendor caches
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.turbo',
  '.cache',
  '.npm',
  '.pnpm',
  '.yarn',
  '.git',
  '.gradle',
  '.m2',
  '.idea',
  '.vscode',
  // System / OS dirs
  'Library',
  '.Trash',
  '.DS_Store',
  // Python venvs and friends
  'venv',
  '.venv',
  '__pycache__',
  // one-skill's own bookkeeping (so it doesn't recurse into itself)
  '.one-skill',
  // Agent dirs themselves — we look for `<root>/.claude/skills`, never descend into `.claude`
  '.claude',
  '.cursor',
  '.codex',
  '.openclaw',
]);

async function hasNonEmptyDir(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    if (!st.isDirectory()) return false;
    const entries = await readdir(p);
    return entries.some((e) => !e.startsWith('.'));
  } catch {
    return false;
  }
}

/**
 * Walk the user's home tree looking for directories that contain at least one
 * of the per-project Agent skill roots (`.claude/skills/`, `.cursor/skills-cursor/`,
 * `.codex/pets/`). Returns each unique match sorted by depth then path.
 *
 * The walk is intentionally simple — depth-limited, prune-list-based — to keep
 * scans sub-second on a typical home folder.
 */
export async function findProjectCandidates(
  opts: ScanCandidatesOptions = {},
): Promise<ProjectCandidate[]> {
  const home = opts.home ?? homedir();
  const maxDepth = opts.maxDepth ?? 5;
  const skip = new Set<string>([...(opts.confirmedPaths ?? []), ...(opts.dismissedPaths ?? [])]);
  const found: ProjectCandidate[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (skip.has(dir)) return;

    // Don't consider `home` itself as a "project" — `~/.claude/skills/` is the user scope.
    if (dir !== home) {
      const [hasClaudeCode, hasCursor, hasCodex] = await Promise.all([
        hasNonEmptyDir(join(dir, '.claude', 'skills')),
        hasNonEmptyDir(join(dir, '.cursor', 'skills-cursor')),
        hasNonEmptyDir(join(dir, '.codex', 'pets')),
      ]);
      if (hasClaudeCode || hasCursor || hasCodex) {
        found.push({ path: dir, basename: basename(dir), hasClaudeCode, hasCursor, hasCodex });
        // Don't descend further into a confirmed project — sub-projects nested
        // inside another project root are an edge case we ignore.
        return;
      }
    }

    let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (PRUNE_DIRS.has(entry.name)) continue;
      // Skip hidden dirs other than the ones we explicitly handle above.
      if (entry.name.startsWith('.')) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(home, 0);
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}
