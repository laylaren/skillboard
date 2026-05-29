import { join } from 'node:path';
import { stat, mkdir, cp, rm, readdir } from 'node:fs/promises';
import { ensureOneSkillDirs, skillIdToDirname } from '../paths.js';
import { git } from './git.js';

export interface SkillRepo {
  /** Absolute path to the per-skill git repo. */
  repoDir: string;
  /** Subdir inside the repo where the skill's files live. */
  workDir: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Locate (and lazily initialize) the version repo for a given skill id. */
export async function getSkillRepo(skillId: string, home?: string): Promise<SkillRepo> {
  const paths = await ensureOneSkillDirs(home);
  const repoDir = join(paths.versions, skillIdToDirname(skillId));
  const workDir = join(repoDir, 'skill');

  if (!(await exists(join(repoDir, '.git')))) {
    await mkdir(workDir, { recursive: true });
    await git(['init', '-q', '-b', 'main'], repoDir);
    await git(['config', 'user.email', 'skillboard@localhost'], repoDir);
    await git(['config', 'user.name', 'skillboard'], repoDir);
    // Seed commit so HEAD always exists, even before the first snapshot.
    await git(['commit', '--allow-empty', '-q', '-m', 'init'], repoDir);
  }

  return { repoDir, workDir };
}

/**
 * Mirror `sourceDir` into the repo's working directory, then stage everything.
 * We delete the existing contents first so removals propagate as deletions in git.
 *
 * `dereference: true` so that when the skill entry itself is a symlink (which
 * is how the same physical skill can show up in multiple Agent scopes), we
 * capture the content it points to instead of trying to copy the link as-is.
 */
export async function syncIntoRepo(repo: SkillRepo, sourceDir: string): Promise<void> {
  for (const entry of await readdir(repo.workDir, { withFileTypes: true }).catch(() => [])) {
    await rm(join(repo.workDir, entry.name), { recursive: true, force: true });
  }
  await cp(sourceDir, repo.workDir, { recursive: true, dereference: true });
  await git(['add', '-A'], repo.repoDir);
}
