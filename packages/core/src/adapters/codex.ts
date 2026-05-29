import { join } from 'node:path';
import type { ScopeRoot } from '../types.js';
import type { Adapter } from './types.js';

/**
 * Codex CLI Agent Skills live at `$CODEX_HOME/skills` (default `~/.codex/skills/`),
 * each a directory with a `SKILL.md` — the same on-disk format as Claude Code.
 * We declare both user-level and project-level skill roots; the scanner skips
 * roots that don't exist.
 */
export const codexAdapter: Adapter = {
  agent: 'codex',
  async resolveScopes({ projectRoots, home }): Promise<ScopeRoot[]> {
    const scopes: ScopeRoot[] = projectRoots.map((proj) => ({
      agent: 'codex',
      scope: 'project',
      root: join(proj.path, '.codex', 'skills'),
      readOnly: false,
      label: `codex · project · ${proj.label}`,
      priority: 2,
      projectLabel: proj.label,
      projectPath: proj.path,
    }));
    scopes.push({
      agent: 'codex',
      scope: 'user',
      root: join(home, '.codex', 'skills'),
      readOnly: false,
      label: 'codex · user',
      priority: 1,
      projectLabel: null,
      projectPath: null,
    });
    return scopes;
  },
};
