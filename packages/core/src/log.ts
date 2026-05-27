import { appendFile, readFile } from 'node:fs/promises';
import { ensureOneSkillDirs } from './paths.js';

export interface LogEntry {
  timestamp: string;
  /** Short verb: enable / disable / remove / snapshot / rollback / install. */
  action: string;
  /** Skill id this entry refers to, when applicable. */
  skillId?: string;
  /** Free-form details (paths involved, git sha, etc.). */
  detail?: Record<string, unknown>;
}

export async function appendLog(entry: Omit<LogEntry, 'timestamp'>, home?: string): Promise<LogEntry> {
  const paths = await ensureOneSkillDirs(home);
  const full: LogEntry = { timestamp: new Date().toISOString(), ...entry };
  await appendFile(paths.logFile, JSON.stringify(full) + '\n', 'utf8');
  return full;
}

export async function readLog(home?: string): Promise<LogEntry[]> {
  const paths = await ensureOneSkillDirs(home);
  let raw: string;
  try {
    raw = await readFile(paths.logFile, 'utf8');
  } catch {
    return [];
  }
  const out: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}
