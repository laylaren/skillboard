import type { Skill } from '../types.js';
import { appendLog } from '../log.js';
import { git } from './git.js';
import { getSkillRepo, syncIntoRepo } from './repo.js';

export type SnapshotTrigger =
  | 'install'
  | 'update'
  | 'external-edit'
  | 'rollback'
  | 'manual-snapshot'
  | 'enable'
  | 'disable'
  | 'remove';

export interface SnapshotOptions {
  trigger: SnapshotTrigger;
  origin?: string;
  userNote?: string;
  home?: string;
}

export interface SnapshotResult {
  /** Git commit sha created by this snapshot, or null if there were no changes. */
  commit: string | null;
  /** True if this commit actually changed contents (false = trigger logged but no new git commit). */
  changed: boolean;
}

/**
 * Capture the current state of a skill into its version repo and write an audit log entry.
 *
 * If the working tree is unchanged we still write a log entry (for trigger=enable/disable
 * lifecycle events) but skip the git commit so history isn't littered with empty commits.
 */
export async function snapshotSkill(skill: Skill, opts: SnapshotOptions): Promise<SnapshotResult> {
  const repo = await getSkillRepo(skill.id, opts.home);
  await syncIntoRepo(repo, skill.path);

  // Did `git add -A` actually stage anything?
  const status = await git(['status', '--porcelain'], repo.repoDir);
  const hasChanges = status.stdout.trim().length > 0;

  let commit: string | null = null;
  if (hasChanges) {
    const msg = buildCommitMessage(opts);
    await git(['commit', '-q', '-m', msg], repo.repoDir);
    const head = await git(['rev-parse', 'HEAD'], repo.repoDir);
    commit = head.stdout.trim();
  }

  await appendLog(
    {
      action: 'snapshot',
      skillId: skill.id,
      detail: {
        trigger: opts.trigger,
        commit,
        changed: hasChanges,
        origin: opts.origin,
        userNote: opts.userNote,
        contentSha: skill.contentSha,
        path: skill.path,
      },
    },
    opts.home,
  );

  return { commit, changed: hasChanges };
}

function buildCommitMessage(opts: SnapshotOptions): string {
  const parts: string[] = [opts.trigger];
  if (opts.origin) parts.push(`origin=${opts.origin}`);
  if (opts.userNote) parts.push(`note=${opts.userNote.replace(/\n/g, ' ')}`);
  return parts.join(' · ');
}
