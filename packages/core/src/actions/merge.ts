import { dirname, basename, relative, join } from 'node:path';
import { symlink, unlink, lstat, cp, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Skill } from '../types.js';
import { scan } from '../scanner.js';
import { analyzeMerge, type MergeCandidate, type MergePlanItem } from '../merge-plan.js';
import { snapshotSkill } from '../versioning/snapshot.js';
import { moveToTrash, type TrashEntry } from '../trash.js';
import { appendLog } from '../log.js';

export interface MergeOptions {
  /** Default `~/.agents/skills`. */
  canonicalRoot?: string;
  /** Override home (mostly for tests). */
  home?: string;
}

export interface MergeOneOptions extends MergeOptions {
  /**
   * When contents differ between candidates, you MUST pass the realPath of the
   * winner here. When contents are identical and canonical is unambiguous, this
   * can be omitted — the canonical candidate wins automatically.
   */
  winnerRealPath?: string;
}

export interface MergeReplacement {
  /** Skill entry that got replaced. */
  skill: Skill;
  /** Where its old physical directory now lives. */
  trash: TrashEntry;
  /** The symlink path that was created (= skill.path, but kept explicit). */
  symlinkAt: string;
  /** Where the symlink now points. */
  pointsTo: string;
}

export interface MergeResult {
  name: string;
  winner: MergeCandidate;
  replacements: MergeReplacement[];
  /** True when no replacements were needed (already merged). */
  noop: boolean;
}

function defaultCanonical(home: string): string {
  return `${home}/.agents/skills`;
}

async function findPlan(name: string, opts: MergeOptions): Promise<MergePlanItem> {
  const home = opts.home ?? homedir();
  const canonical = opts.canonicalRoot ?? defaultCanonical(home);
  const result = await scan({ home });
  const plans = await analyzeMerge(result.skills, canonical);
  const found = plans.find((p) => p.name === name);
  if (!found) {
    throw new Error(`no real conflict found for skill name "${name}"`);
  }
  return found;
}

/**
 * Merge one conflict.
 *
 * Strategy (matches the user's declared policy):
 *   - Find the winner:
 *       * If `winnerRealPath` is given, it must match one of the candidates.
 *       * Otherwise contents MUST be identical AND there must be exactly one
 *         candidate in the canonical root — that becomes the winner.
 *   - Snapshot every member of every candidate (so the version history captures
 *     the pre-merge state for both winner and loser).
 *   - For every loser candidate:
 *       * Move its physical realPath into the trash.
 *       * For every member of that loser, replace the on-disk `skill.path` with
 *         a symlink pointing at the winner's realPath. (When the loser had no
 *         symlinks of its own — i.e. realPath === path — the original file IS
 *         what got moved to trash; we recreate it as a symlink at the same
 *         location.)
 */
export async function mergeSkill(name: string, opts: MergeOneOptions = {}): Promise<MergeResult> {
  const plan = await findPlan(name, opts);

  if (plan.candidates.some((c) => c.members.some((m) => m.readOnly))) {
    throw new Error(
      `cannot merge "${name}": at least one candidate is read-only (plugin-bundled)`,
    );
  }

  // --- 1. Decide the winner ---
  let winner: MergeCandidate;
  if (opts.winnerRealPath) {
    const found = plan.candidates.find((c) => c.realPath === opts.winnerRealPath);
    if (!found) {
      throw new Error(
        `winnerRealPath ${opts.winnerRealPath} does not match any candidate for "${name}"`,
      );
    }
    winner = found;
  } else {
    if (!plan.contentsIdentical) {
      throw new Error(
        `cannot auto-merge "${name}": contents differ between candidates. ` +
          `Call again with an explicit winnerRealPath.`,
      );
    }
    if (!plan.canonicalWinner) {
      throw new Error(
        `cannot auto-merge "${name}": no unique canonical candidate. ` +
          `Call again with an explicit winnerRealPath.`,
      );
    }
    winner = plan.canonicalWinner;
  }

  const losers = plan.candidates.filter((c) => c.realPath !== winner.realPath);
  if (losers.length === 0) {
    await appendLog({ action: 'merge', skillId: name, detail: { result: 'noop', winner: winner.realPath } }, opts.home);
    return { name, winner, replacements: [], noop: true };
  }

  // --- 2. Snapshot everything we're about to disturb ---
  for (const cand of plan.candidates) {
    for (const m of cand.members) {
      await snapshotSkill(m, { trigger: 'manual-snapshot', userNote: `pre-merge winner=${winner.realPath}`, home: opts.home });
    }
  }

  const replacements: MergeReplacement[] = [];

  // --- 3. For each loser candidate, point it at the winner's realPath ---
  for (const loser of losers) {
    await relocateCandidate(loser, winner.realPath, replacements, opts.home);
  }

  await appendLog(
    {
      action: 'merge',
      skillId: name,
      detail: {
        winner: winner.realPath,
        losers: losers.map((l) => l.realPath),
        replacements: replacements.map((r) => ({ at: r.symlinkAt, trash: r.trash.trashPath })),
      },
    },
    opts.home,
  );

  return { name, winner, replacements, noop: false };
}

/**
 * Replace a single skill entry (which is currently a symlink at `member.path`)
 * with a fresh symlink pointing at `winnerRealPath`. The original is moved to
 * trash for recovery.
 */
async function replaceWithSymlink(member: Skill, winnerRealPath: string): Promise<MergeReplacement> {
  // Verify the path is still a symlink before unlinking.
  const ls = await lstat(member.path).catch(() => null);
  if (!ls || !ls.isSymbolicLink()) {
    // Defensive: if it's not a symlink, treat it the same as a "direct member"
    // — move to trash, then recreate.
    const trash = await moveToTrash(member.path);
    await symlink(winnerRealPath, member.path);
    return { skill: member, trash, symlinkAt: member.path, pointsTo: winnerRealPath };
  }
  // Symlink: just unlink and recreate. We still log it to trash for traceability
  // by writing a marker file? Skip — symlinks are cheap, and the audit log
  // records the change.
  await unlink(member.path);
  await symlink(winnerRealPath, member.path);
  return {
    skill: member,
    trash: { trashPath: '(symlink — not preserved)', originalPath: member.path },
    symlinkAt: member.path,
    pointsTo: winnerRealPath,
  };
}

/**
 * Repoint a single conflict candidate at `winnerRealPath`: every member of the
 * candidate ends up as a symlink to the winner, and the candidate's own
 * physical directory is moved to trash. Members whose `path` already IS
 * `winnerRealPath` (i.e. the winner lives here) are left untouched — we never
 * symlink a directory onto itself.
 */
async function relocateCandidate(
  cand: MergeCandidate,
  winnerRealPath: string,
  replacements: MergeReplacement[],
  home?: string,
): Promise<void> {
  // First, repoint every symlink member that lives OUTSIDE the candidate's
  // realPath. (These don't depend on the candidate's realPath, so do them first.)
  const symlinkMembers = cand.members.filter((m) => m.realPath !== m.path && m.path !== winnerRealPath);
  for (const member of symlinkMembers) {
    replacements.push(await replaceWithSymlink(member, winnerRealPath));
  }

  // Then the "original" members — entries whose `path === realPath`. Move each
  // directory to trash and recreate a symlink in its place.
  const directMembers = cand.members.filter((m) => m.realPath === m.path && m.path !== winnerRealPath);
  if (directMembers.length === 0) {
    // Nobody owns this candidate directly — stray realPath. Trash it, unless it
    // IS the winner's directory (when converging in place).
    if (cand.realPath === winnerRealPath) return;
    const trash = await moveToTrash(cand.realPath, home);
    replacements.push({
      skill: cand.members[0]!,
      trash,
      symlinkAt: cand.realPath,
      pointsTo: winnerRealPath,
    });
    await symlink(winnerRealPath, cand.realPath);
  } else {
    for (const member of directMembers) {
      const trash = await moveToTrash(member.path, home);
      await symlink(winnerRealPath, member.path);
      replacements.push({
        skill: member,
        trash,
        symlinkAt: member.path,
        pointsTo: winnerRealPath,
      });
    }
  }
}

/**
 * Converge a conflict into the canonical root (`~/.agents/skills/<name>`).
 *
 * Unlike `mergeSkill` — which keeps the winner's content wherever it already
 * lives — this RELOCATES the winning content into `.agents/skills` and turns
 * every existing copy (including the winner's old location) into a symlink
 * pointing at the new canonical directory. Use it when no candidate yet lives
 * in `.agents` and you want the conflict resolved there.
 *
 * Winner selection:
 *   - `winnerRealPath` given → that candidate's content becomes canonical.
 *   - omitted + contents identical → any candidate works (canonical/newest first).
 *   - omitted + contents differ → error; the caller must pick.
 */
export async function mergeSkillToCanonical(
  name: string,
  opts: MergeOneOptions = {},
): Promise<MergeResult> {
  const home = opts.home ?? homedir();
  const canonicalRoot = opts.canonicalRoot ?? defaultCanonical(home);
  const plan = await findPlan(name, { ...opts, home, canonicalRoot });

  if (plan.candidates.some((c) => c.members.some((m) => m.readOnly))) {
    throw new Error(
      `cannot merge "${name}": at least one candidate is read-only (plugin-bundled)`,
    );
  }

  // --- 1. Decide whose content becomes canonical ---
  let winner: MergeCandidate;
  if (opts.winnerRealPath) {
    const found = plan.candidates.find((c) => c.realPath === opts.winnerRealPath);
    if (!found) {
      throw new Error(
        `winnerRealPath ${opts.winnerRealPath} does not match any candidate for "${name}"`,
      );
    }
    winner = found;
  } else if (plan.contentsIdentical) {
    winner = plan.canonicalWinner ?? plan.newestWinner ?? plan.candidates[0]!;
  } else {
    throw new Error(
      `cannot converge "${name}" into canonical: contents differ between candidates. ` +
        `Call again with an explicit winnerRealPath.`,
    );
  }

  // Resolve the canonical target path. `realpath` keeps us consistent with the
  // already-canonicalized candidate realPaths (e.g. /tmp vs /private/tmp).
  const canonicalRootReal = await realpath(canonicalRoot).catch(() => canonicalRoot);
  const target = join(canonicalRootReal, name);

  // If the winner already lives at the canonical target, there's nothing to
  // relocate — fall back to a plain merge with that winner.
  if (winner.realPath === target) {
    return mergeSkill(name, { ...opts, winnerRealPath: winner.realPath, home, canonicalRoot });
  }

  // --- 2. Snapshot everything we're about to disturb ---
  for (const cand of plan.candidates) {
    for (const m of cand.members) {
      await snapshotSkill(m, {
        trigger: 'manual-snapshot',
        userNote: `pre-converge → ${target}`,
        home,
      });
    }
  }

  // --- 3. Materialize the winner's content at the canonical target ---
  await mkdir(canonicalRootReal, { recursive: true });
  const existing = await lstat(target).catch(() => null);
  if (existing) {
    const isCandidate = plan.candidates.some((c) => c.realPath === target);
    if (!isCandidate) {
      throw new Error(
        `cannot converge "${name}": ${target} already exists and is not part of this conflict`,
      );
    }
    // A candidate already sits at the target but isn't the chosen winner — trash
    // it so we can drop the winner's content there instead.
    await moveToTrash(target, home);
  }
  await cp(winner.realPath, target, { recursive: true });

  // --- 4. Turn every candidate into a symlink pointing at the canonical dir ---
  const replacements: MergeReplacement[] = [];
  for (const cand of plan.candidates) {
    await relocateCandidate(cand, target, replacements, home);
  }

  // The returned "winner" reflects the new canonical location.
  const canonicalWinner: MergeCandidate = {
    ...winner,
    realPath: target,
    inCanonicalRoot: true,
  };

  await appendLog(
    {
      action: 'merge',
      skillId: name,
      detail: {
        strategy: 'converge-to-canonical',
        target,
        contentFrom: winner.realPath,
        candidates: plan.candidates.map((c) => c.realPath),
        replacements: replacements.map((r) => ({ at: r.symlinkAt, trash: r.trash.trashPath })),
      },
    },
    home,
  );

  return { name, winner: canonicalWinner, replacements, noop: false };
}

/**
 * Merge every conflict whose `safeHybridAction === 'silent-merge'`. Skips the rest.
 */
export async function mergeAllSafe(opts: MergeOptions = {}): Promise<MergeResult[]> {
  const home = opts.home ?? homedir();
  const canonical = opts.canonicalRoot ?? defaultCanonical(home);
  const result = await scan({ home });
  const plans = await analyzeMerge(result.skills, canonical);
  const safe = plans.filter((p) => p.safeHybridAction === 'silent-merge');

  const results: MergeResult[] = [];
  for (const plan of safe) {
    try {
      results.push(await mergeSkill(plan.name, opts));
    } catch (err) {
      // Don't let one failure abort the batch — log and continue.
      await appendLog(
        {
          action: 'merge',
          skillId: plan.name,
          detail: { error: (err as Error).message, batch: 'all-safe' },
        },
        opts.home,
      );
    }
  }
  return results;
}

/** Re-export the canonical default so server/CLI can show it in UI. */
export function defaultCanonicalRoot(home: string = homedir()): string {
  return defaultCanonical(home);
}

// Convenience for relative-path nudges in CLI output (not part of public API)
export const _relForLog = (p: string, base: string) => relative(base, p) || basename(p);
