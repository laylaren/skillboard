import { join } from 'node:path';
import { cp, rm, readdir, mkdir } from 'node:fs/promises';
import type { Skill } from '../types.js';
import { getSkillRepo } from './repo.js';
import { git } from './git.js';
import { snapshotSkill } from './snapshot.js';

/**
 * Restore a skill's on-disk files to the state captured by `commit`.
 *
 * Strategy: in the repo, check out the target commit into the working dir, then
 * mirror that working dir back to the skill's live path. Before doing anything
 * we take a `pre-rollback` snapshot so the user can roll forward again.
 */
export async function rollbackSkill(
  skill: Skill,
  commit: string,
  home?: string,
): Promise<{ commit: string }> {
  // Step 1: snapshot current state so we can come back.
  await snapshotSkill(skill, { trigger: 'manual-snapshot', userNote: 'pre-rollback', home });

  const repo = await getSkillRepo(skill.id, home);

  // Step 2: check out the target commit's tree into the repo working dir.
  // `git checkout <commit> -- .` updates the index + worktree from that commit.
  await git(['checkout', commit, '--', '.'], repo.repoDir);

  // Step 3: mirror repo working dir → live skill path. Wipe live first so deletes propagate.
  await mkdir(skill.path, { recursive: true });
  for (const entry of await readdir(skill.path, { withFileTypes: true }).catch(() => [])) {
    await rm(join(skill.path, entry.name), { recursive: true, force: true });
  }
  await cp(repo.workDir, skill.path, { recursive: true });

  // Step 4: snapshot the post-rollback state (trigger=rollback) so the timeline
  //         shows the restore as its own event with the source commit recorded.
  const result = await snapshotSkill(skill, {
    trigger: 'rollback',
    origin: `rollback-from:${commit}`,
    home,
  });

  return { commit: result.commit ?? commit };
}
