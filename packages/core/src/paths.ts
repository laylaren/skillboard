import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

/**
 * Central layout of `~/.one-skill/`. Everything we persist to disk hangs off here.
 */
export interface OneSkillPaths {
  root: string;
  trash: string;
  versions: string;
  logFile: string;
}

export function resolveOneSkillPaths(home: string = homedir()): OneSkillPaths {
  const root = join(home, '.one-skill');
  return {
    root,
    trash: join(root, 'trash'),
    versions: join(root, 'versions'),
    logFile: join(root, 'log.jsonl'),
  };
}

/** Ensure base dirs exist. Cheap to call repeatedly. */
export async function ensureOneSkillDirs(home?: string): Promise<OneSkillPaths> {
  const paths = resolveOneSkillPaths(home);
  await mkdir(paths.trash, { recursive: true });
  await mkdir(paths.versions, { recursive: true });
  return paths;
}

/** Sanitize a skill id (`agent:scope:name`) into something safe for a directory name. */
export function skillIdToDirname(skillId: string): string {
  return skillId.replace(/[^a-zA-Z0-9._-]/g, '_');
}
