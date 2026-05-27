import { join } from 'node:path';
import type { ScopeRoot } from '../types.js';
import type { Adapter } from './types.js';

/**
 * openclaw layout (both directories live under the user's home — neither one is
 * per-project in the way claude-code's `<cwd>/.claude/skills/` is):
 *
 *   ~/.openclaw/workspace/skills/   — higher priority; openclaw loads from here first
 *   ~/.openclaw/skills/             — lower priority; system/global skills, used when
 *                                     workspace doesn't define the same name
 *
 * So when both directories contain a skill called "lark-mail", openclaw uses
 * the workspace copy at runtime — that's the one tagged `loaded` in the UI.
 */
export const openclawAdapter: Adapter = {
  agent: 'openclaw',
  async resolveScopes({ home }): Promise<ScopeRoot[]> {
    return [
      {
        agent: 'openclaw',
        scope: 'workspace',
        root: join(home, '.openclaw', 'workspace', 'skills'),
        readOnly: false,
        label: 'openclaw · workspace',
        priority: 2,
        projectLabel: null,
        projectPath: null,
      },
      {
        agent: 'openclaw',
        scope: 'system',
        root: join(home, '.openclaw', 'skills'),
        readOnly: false,
        label: 'openclaw · system',
        priority: 1,
        projectLabel: null,
        projectPath: null,
      },
    ];
  },
};
