import { join } from 'node:path';
import type { ScopeRoot } from '../types.js';
import type { Adapter } from './types.js';

export const cursorAdapter: Adapter = {
  agent: 'cursor',
  async resolveScopes({ projectRoots, home }): Promise<ScopeRoot[]> {
    const scopes: ScopeRoot[] = projectRoots.map((proj) => ({
      agent: 'cursor',
      scope: 'project',
      root: join(proj.path, '.cursor', 'skills-cursor'),
      readOnly: false,
      label: `cursor · project · ${proj.label}`,
      priority: 2,
      projectLabel: proj.label,
      projectPath: proj.path,
    }));
    scopes.push({
      agent: 'cursor',
      scope: 'user',
      root: join(home, '.cursor', 'skills-cursor'),
      readOnly: false,
      label: 'cursor · user',
      priority: 1,
      projectLabel: null,
      projectPath: null,
    });
    return scopes;
  },
};
