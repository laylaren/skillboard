import { join } from 'node:path';
import type { ScopeRoot } from '../types.js';
import type { Adapter } from './types.js';

/**
 * Agents: the cross-tool canonical location for skills, `.agents/skills`.
 *
 * This is the same root that skillboard's merge step consolidates into
 * (`~/.agents/skills`), so surfacing it as its own agent lets the user see and
 * manage the canonical copies directly. User-level (`~/.agents/skills`) and
 * project-level (`<project>/.agents/skills`) scopes only.
 */
export const agentsAdapter: Adapter = {
  agent: 'agents',
  async resolveScopes({ projectRoots, home }): Promise<ScopeRoot[]> {
    const scopes: ScopeRoot[] = projectRoots.map((proj) => ({
      agent: 'agents',
      scope: 'project',
      root: join(proj.path, '.agents', 'skills'),
      readOnly: false,
      label: `agents · project · ${proj.label}`,
      priority: 2,
      projectLabel: proj.label,
      projectPath: proj.path,
    }));
    scopes.push({
      agent: 'agents',
      scope: 'user',
      root: join(home, '.agents', 'skills'),
      readOnly: false,
      label: 'agents · user',
      priority: 1,
      projectLabel: null,
      projectPath: null,
    });
    return scopes;
  },
};
