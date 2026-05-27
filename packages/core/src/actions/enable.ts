import { dirname, basename, join } from 'node:path';
import { rename, mkdir, stat } from 'node:fs/promises';
import type { Skill } from '../types.js';
import { appendLog } from '../log.js';
import { snapshotSkill } from '../versioning/snapshot.js';
import { scan } from '../scanner.js';

export interface ToggleResult {
  skill: Skill;
  fromPath: string;
  toPath: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a disabled skill (currently inside its scope's `.disabled/` dir) back into
 * the live scope. No-op if already enabled.
 */
export async function enableSkill(skill: Skill, home?: string): Promise<ToggleResult> {
  if (skill.readOnly) throw new Error(`cannot enable read-only skill: ${skill.id}`);
  if (!skill.disabled) {
    return { skill, fromPath: skill.path, toPath: skill.path };
  }

  // `<scopeRoot>/.disabled/<name>` → `<scopeRoot>/<name>`
  const disabledDir = dirname(skill.path);
  const scopeRoot = dirname(disabledDir);
  const target = join(scopeRoot, basename(skill.path));

  if (await exists(target)) {
    throw new Error(`cannot enable: target already exists at ${target}`);
  }
  await rename(skill.path, target);

  await appendLog(
    { action: 'enable', skillId: skill.id, detail: { from: skill.path, to: target } },
    home,
  );

  const updated = await refreshSkill(skill, home);
  await snapshotSkill(updated, { trigger: 'enable', home });
  return { skill: updated, fromPath: skill.path, toPath: target };
}

/**
 * Move a live skill into the scope's `.disabled/` sibling dir. No-op if already disabled.
 */
export async function disableSkill(skill: Skill, home?: string): Promise<ToggleResult> {
  if (skill.readOnly) throw new Error(`cannot disable read-only skill: ${skill.id}`);
  if (skill.disabled) {
    return { skill, fromPath: skill.path, toPath: skill.path };
  }

  // `<scopeRoot>/<name>` → `<scopeRoot>/.disabled/<name>`
  const scopeRoot = dirname(skill.path);
  const disabledDir = join(scopeRoot, '.disabled');
  await mkdir(disabledDir, { recursive: true });
  const target = join(disabledDir, basename(skill.path));

  if (await exists(target)) {
    throw new Error(`cannot disable: an entry already exists at ${target}`);
  }
  await rename(skill.path, target);

  await appendLog(
    { action: 'disable', skillId: skill.id, detail: { from: skill.path, to: target } },
    home,
  );

  const updated = await refreshSkill(skill, home);
  await snapshotSkill(updated, { trigger: 'disable', home });
  return { skill: updated, fromPath: skill.path, toPath: target };
}

/** Re-scan and find the skill at its new location (path changed after move). */
async function refreshSkill(prev: Skill, home?: string): Promise<Skill> {
  const result = await scan({ home, agents: [prev.agent] });
  const found = result.skills.find((s) => s.id === prev.id);
  if (!found) throw new Error(`post-toggle scan could not find ${prev.id}`);
  return found;
}
