import { join } from 'node:path';
import type { ScopeRoot } from '../types.js';
import type { Adapter } from './types.js';

/**
 * Codex doesn't have a first-class skill system on disk; "pets" (each with a `pet.json`)
 * is the closest analogue. We declare both user-level and project-level pets directories;
 * the scanner skips roots that don't exist.
 *
 * Pet manifest parsing (pet.json) is a separate concern — for now we just enumerate
 * directories and let the SKILL.md-based parser return empty frontmatter.
 */
export const codexAdapter: Adapter = {
  agent: 'codex',
  async resolveScopes({ projectRoots, home }): Promise<ScopeRoot[]> {
    const scopes: ScopeRoot[] = projectRoots.map((proj) => ({
      agent: 'codex',
      scope: 'project',
      root: join(proj.path, '.codex', 'pets'),
      readOnly: false,
      label: `codex · project · ${proj.label}`,
      priority: 2,
      projectLabel: proj.label,
      projectPath: proj.path,
    }));
    scopes.push({
      agent: 'codex',
      scope: 'user',
      root: join(home, '.codex', 'pets'),
      readOnly: false,
      label: 'codex · user (pets)',
      priority: 1,
      projectLabel: null,
      projectPath: null,
    });
    return scopes;
  },
};
