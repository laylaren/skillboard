import { join } from 'node:path';
import { readdir, rename, stat } from 'node:fs/promises';
import { resolveOneSkillPaths } from './paths.js';
import { readProjects } from './projects.js';

export interface MigrationResult {
  renamed: { from: string; to: string }[];
  skipped: { name: string; reason: string }[];
}

/**
 * One-time rename of openclaw version repos to follow the renamed scope tags
 * (`project` → `workspace`, `user` → `system`). Idempotent: if the source dir
 * doesn't exist or the target already exists, the entry is skipped.
 *
 * Only touches dirs under `~/.one-skill/versions/`. The actual skill files on
 * disk aren't affected — scope is purely a logical tag baked into the skill id.
 */
export async function migrateOpenclawScopeNames(home?: string): Promise<MigrationResult> {
  const paths = resolveOneSkillPaths(home);
  const result: MigrationResult = { renamed: [], skipped: [] };

  let entries: string[];
  try {
    entries = await readdir(paths.versions);
  } catch {
    // versions dir doesn't exist yet — nothing to migrate.
    return result;
  }

  for (const name of entries) {
    let newName: string | null = null;
    if (name.startsWith('openclaw_project_')) {
      newName = 'openclaw_workspace_' + name.slice('openclaw_project_'.length);
    } else if (name.startsWith('openclaw_user_')) {
      newName = 'openclaw_system_' + name.slice('openclaw_user_'.length);
    }
    if (!newName) continue;

    const from = join(paths.versions, name);
    const to = join(paths.versions, newName);

    // Refuse to overwrite an existing target — leaves both intact for manual
    // inspection rather than silently losing history.
    if (await pathExists(to)) {
      result.skipped.push({ name, reason: `target already exists: ${newName}` });
      continue;
    }

    try {
      await rename(from, to);
      result.renamed.push({ from: name, to: newName });
    } catch (err) {
      result.skipped.push({ name, reason: (err as Error).message });
    }
  }

  return result;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rename pre-multi-project version repos to include the project label.
 *
 * Old shape: `<agent>_project_<skillName>` (one project per host, no label).
 * New shape: `<agent>_project_<projectLabel>_<skillName>` (multi-project).
 *
 * We only renaming repos for agents that have a per-project scope on the same
 * host AND when there's exactly one configured project (single bootstrap).
 * Multi-project hosts mean we don't know which project a legacy repo belongs to,
 * so we leave those alone — those repos become orphans and the new history
 * starts fresh, which is the right safe behavior.
 */
export async function migrateProjectScopeNames(home?: string): Promise<MigrationResult> {
  const paths = resolveOneSkillPaths(home);
  const result: MigrationResult = { renamed: [], skipped: [] };

  const projectsState = await readProjects(home);
  if (projectsState.projects.length !== 1) return result;
  const onlyProject = projectsState.projects[0]!;
  const label = onlyProject.label;

  let entries: string[];
  try {
    entries = await readdir(paths.versions);
  } catch {
    return result;
  }

  // Match `<agent>_project_<skillName>` where <agent> is a project-capable agent.
  // Bare `_project_<...>` is unambiguous because non-project scopes use other
  // tokens (user, workspace, system).
  const agentsWithProjectScope = ['claude-code', 'cursor', 'codex'];

  for (const name of entries) {
    let agent: string | null = null;
    for (const a of agentsWithProjectScope) {
      if (name.startsWith(`${a}_project_`)) {
        agent = a;
        break;
      }
    }
    if (!agent) continue;
    const skillTail = name.slice(`${agent}_project_`.length);

    // Already migrated entries start with `<projectLabel>_` — heuristic match.
    if (skillTail.startsWith(`${label}_`)) continue;

    const newName = `${agent}_project_${label}_${skillTail}`;
    const from = join(paths.versions, name);
    const to = join(paths.versions, newName);

    if (await pathExists(to)) {
      result.skipped.push({ name, reason: `target already exists: ${newName}` });
      continue;
    }
    try {
      await rename(from, to);
      result.renamed.push({ from: name, to: newName });
    } catch (err) {
      result.skipped.push({ name, reason: (err as Error).message });
    }
  }

  return result;
}
