import type { Skill } from '../types.js';
import { appendLog } from '../log.js';
import { moveToTrash, type TrashEntry } from '../trash.js';
import { snapshotSkill } from '../versioning/snapshot.js';

export interface RemoveResult {
  skill: Skill;
  trash: TrashEntry;
}

/**
 * Remove a skill: first snapshot its current state (so it can be restored from history
 * even after deletion), then move its directory into the trash. Plugin (read-only) skills
 * are rejected — those are owned by `/plugin`.
 */
export async function removeSkill(skill: Skill, home?: string): Promise<RemoveResult> {
  if (skill.readOnly) {
    throw new Error(`cannot remove read-only skill: ${skill.id} (managed by /plugin)`);
  }

  // Snapshot first — captures the final state before deletion.
  await snapshotSkill(skill, { trigger: 'remove', home });

  const trash = await moveToTrash(skill.path, home);

  await appendLog(
    { action: 'remove', skillId: skill.id, detail: { from: skill.path, trash: trash.trashPath } },
    home,
  );

  return { skill, trash };
}
