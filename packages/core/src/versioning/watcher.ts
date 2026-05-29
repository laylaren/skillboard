import chokidar, { type FSWatcher } from 'chokidar';
import type { Skill } from '../types.js';
import { snapshotSkill, type SnapshotResult } from './snapshot.js';

interface WatchEntry {
  watcher: FSWatcher;
  skills: Skill[];
  debounceTimer: NodeJS.Timeout | null;
}

export interface SkillWatcherOptions {
  /** Override the debounce window between the last fs event and the snapshot. */
  debounceMs?: number;
  /** Override `~/.skillboard/` home when persisting. */
  home?: string;
  /** Notified after a successful auto-snapshot (used by the server to push UI updates / logs). */
  onSnapshot?: (skill: Skill, result: SnapshotResult) => void;
  /** Notified on snapshot failure. */
  onError?: (skill: Skill, err: Error) => void;
}

/**
 * Watches the physical directory backing each user/project skill and auto-snapshots
 * it on external edits. Read-only (plugin) skills are skipped — those are managed
 * by /plugin and we never write to their version repos.
 *
 * Multiple skill records can share one `realPath` (cross-agent symlinks). We watch
 * each realPath once and fan the snapshot out to every skill referencing it, so
 * each agent's history line gets its own commit.
 */
export class SkillWatcher {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly opts: Required<Pick<SkillWatcherOptions, 'debounceMs'>> &
    Omit<SkillWatcherOptions, 'debounceMs'>;

  constructor(opts: SkillWatcherOptions = {}) {
    this.opts = { debounceMs: opts.debounceMs ?? 2000, ...opts };
  }

  /**
   * Reconcile the running watcher set against the current scan: start watchers
   * for new physical paths, close watchers whose paths are no longer present.
   * Cheap to call repeatedly — only diffing work is done.
   */
  async sync(skills: Skill[]): Promise<void> {
    const active = new Map<string, Skill[]>();
    for (const s of skills) {
      if (s.readOnly) continue;
      const list = active.get(s.realPath) ?? [];
      list.push(s);
      active.set(s.realPath, list);
    }

    for (const [path, entry] of this.entries) {
      if (!active.has(path)) {
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        await entry.watcher.close();
        this.entries.delete(path);
      }
    }

    for (const [path, skillsHere] of active) {
      const existing = this.entries.get(path);
      if (existing) {
        existing.skills = skillsHere;
        continue;
      }
      const watcher = chokidar.watch(path, {
        ignoreInitial: true,
        ignored: (p) => p.includes('/.git/') || p.endsWith('/.DS_Store'),
        awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
        depth: 10,
      });
      const entry: WatchEntry = { watcher, skills: skillsHere, debounceTimer: null };
      watcher.on('all', () => this.scheduleSnapshot(path));
      this.entries.set(path, entry);
    }
  }

  /** True if the watcher is currently observing the given physical path. */
  isWatching(realPath: string): boolean {
    return this.entries.has(realPath);
  }

  /** Number of physical paths currently watched (for diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /** Stop all watchers and cancel pending debounces. */
  async close(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      await entry.watcher.close();
    }
    this.entries.clear();
  }

  private scheduleSnapshot(realPath: string): void {
    const entry = this.entries.get(realPath);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void this.runSnapshot(realPath);
    }, this.opts.debounceMs);
  }

  private async runSnapshot(realPath: string): Promise<void> {
    const entry = this.entries.get(realPath);
    if (!entry) return;
    for (const skill of entry.skills) {
      try {
        const result = await snapshotSkill(skill, {
          trigger: 'external-edit',
          home: this.opts.home,
        });
        this.opts.onSnapshot?.(skill, result);
      } catch (err) {
        this.opts.onError?.(skill, err as Error);
      }
    }
  }
}
