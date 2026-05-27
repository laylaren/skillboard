import { join, basename } from 'node:path';
import { rename, mkdir, cp, rm } from 'node:fs/promises';
import { ensureOneSkillDirs } from './paths.js';

export interface TrashEntry {
  /** Absolute path inside the trash dir where the original lives now. */
  trashPath: string;
  /** Where the file/dir came from. */
  originalPath: string;
}

/**
 * Move a file or directory into the trash. Falls back to copy+rm if rename fails
 * across filesystems (rare on macOS but possible with mounted volumes).
 */
export async function moveToTrash(originalPath: string, home?: string): Promise<TrashEntry> {
  const paths = await ensureOneSkillDirs(home);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(paths.trash, `${stamp}-${basename(originalPath)}`);
  await mkdir(dir, { recursive: true });
  const trashPath = join(dir, basename(originalPath));

  try {
    await rename(originalPath, trashPath);
  } catch {
    await cp(originalPath, trashPath, { recursive: true });
    await rm(originalPath, { recursive: true, force: true });
  }

  return { trashPath, originalPath };
}
