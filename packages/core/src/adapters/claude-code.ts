import { join } from 'node:path';
import type { ScopeRoot } from '../types.js';
import type { Adapter } from './types.js';

/**
 * Claude Code: user-level and project-level skills only.
 *
 * Plugin-bundled skills (under `~/.claude/plugins/**\/skills`) are intentionally
 * NOT scanned — they're owned by the plugin and managed via `/plugin`. Surfacing
 * them in skillboard just adds noise and read-only entries the user can't act on.
 */
export const claudeCodeAdapter: Adapter = {
  agent: 'claude-code',
  async resolveScopes({ projectRoots, home }): Promise<ScopeRoot[]> {
    // Claude Code prefers the cwd-local copy over the user-level one.
    const scopes: ScopeRoot[] = projectRoots.map((proj) => ({
      agent: 'claude-code',
      scope: 'project',
      root: join(proj.path, '.claude', 'skills'),
      readOnly: false,
      label: `claude-code · project · ${proj.label}`,
      priority: 2,
      projectLabel: proj.label,
      projectPath: proj.path,
    }));
    scopes.push({
      agent: 'claude-code',
      scope: 'user',
      root: join(home, '.claude', 'skills'),
      readOnly: false,
      label: 'claude-code · user',
      priority: 1,
      projectLabel: null,
      projectPath: null,
    });
    return scopes;
  },
};
