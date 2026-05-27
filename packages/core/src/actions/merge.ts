import { dirname, basename, relative } from 'node:path';
import { symlink, unlink, lstat } from 'node:fs/promises';
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

  // --- 3. For each loser candidate ---
  for (const loser of losers) {
    // 3a. First, replace every symlink member that lives OUTSIDE the loser's
    //     realPath with a fresh symlink pointing at the winner's realPath.
    //     (These don't depend on the loser's realPath, so we do them first.)
    const symlinkMembers = loser.members.filter((m) => m.realPath !== m.path);
    for (const member of symlinkMembers) {
      const rep = await replaceWithSymlink(member, winner.realPath);
      replacements.push(rep);
    }

    // 3b. Handle "the original member" — i.e. an entry whose `path === realPath`.
    //     There should be at most one such member per loser candidate. We move
    //     its directory to trash, then recreate a symlink in its place.
    const directMembers = loser.members.filter((m) => m.realPath === m.path);
    if (directMembers.length === 0) {
      // Nobody owns this loser directly — it's a stray realPath. Trash it.
      const trash = await moveToTrash(loser.realPath, opts.home);
      replacements.push({
        skill: loser.members[0]!,
        trash,
        symlinkAt: loser.realPath,
        pointsTo: winner.realPath,
      });
      await symlink(winner.realPath, loser.realPath);
    } else {
      for (const member of directMembers) {
        const trash = await moveToTrash(member.path, opts.home);
        await symlink(winner.realPath, member.path);
        replacements.push({
          skill: member,
          trash,
          symlinkAt: member.path,
          pointsTo: winner.realPath,
        });
      }
    }
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
