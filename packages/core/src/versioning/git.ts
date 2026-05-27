import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Thin wrapper around the system `git` binary. We deliberately avoid an extra
 * runtime dep — every machine that runs Claude Code already has git.
 */
export async function git(args: string[], cwd: string): Promise<GitResult> {
  const { stdout, stderr } = await execFileP('git', args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { stdout, stderr };
}
