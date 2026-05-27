import { getSkillRepo } from './repo.js';
import { git } from './git.js';
import { readLog, type LogEntry } from '../log.js';

export interface HistoryEntry {
  commit: string;
  timestamp: string;
  subject: string;
  /** Audit-log details (trigger, origin, userNote, ...). null if no log entry matched. */
  meta: Record<string, unknown> | null;
}

/**
 * Build the version timeline for a skill by joining `git log` with audit-log entries.
 *
 * git log gives ordered commits with sha + ISO timestamp + message; the audit log
 * carries the structured metadata that doesn't belong in a commit message.
 */
export async function getHistory(skillId: string, home?: string): Promise<HistoryEntry[]> {
  const repo = await getSkillRepo(skillId, home);
  const { stdout } = await git(
    ['log', '--pretty=format:%H%x09%aI%x09%s', '--all'],
    repo.repoDir,
  );
  const lines = stdout.split('\n').filter(Boolean);
  if (lines.length === 0) return [];

  const log = await readLog(home);
  const bySha = new Map<string, LogEntry>();
  for (const entry of log) {
    if (entry.skillId !== skillId || entry.action !== 'snapshot') continue;
    const sha = (entry.detail as { commit?: string } | undefined)?.commit;
    if (sha) bySha.set(sha, entry);
  }

  return lines.map((line) => {
    const [commit = '', timestamp = '', subject = ''] = line.split('\t');
    const meta = bySha.get(commit)?.detail ?? null;
    return { commit, timestamp, subject, meta };
  });
}
