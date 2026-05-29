import { scan, type Skill } from '@ai-skillboard/core';

export interface ResolveOptions {
  agent?: string;
  scope?: string;
  includeDisabled?: boolean;
}

/**
 * Find a single skill by user-supplied identifier. Accepts:
 *   - Full id "<agent>:<scope>:<name>"
 *   - Bare name "lark-mail" — must be unique under any active filters
 *
 * Throws with a helpful message listing all candidates if the input is ambiguous.
 */
export async function resolveSkill(input: string, opts: ResolveOptions = {}): Promise<Skill> {
  const result = await scan();
  let candidates = result.skills;

  if (opts.agent) candidates = candidates.filter((s) => s.agent === opts.agent);
  if (opts.scope) candidates = candidates.filter((s) => s.scope === opts.scope);
  if (!opts.includeDisabled) candidates = candidates.filter((s) => !s.disabled);

  // Exact id match wins.
  const byId = candidates.find((s) => s.id === input);
  if (byId) return byId;

  const byName = candidates.filter((s) => s.name === input);
  if (byName.length === 1) return byName[0]!;
  if (byName.length === 0) {
    throw new Error(
      `no skill matches "${input}"${opts.agent ? ` under agent ${opts.agent}` : ''}${opts.scope ? ` under scope ${opts.scope}` : ''}`,
    );
  }

  const list = byName.map((s) => `  - ${s.id}  (${s.path})`).join('\n');
  throw new Error(
    `"${input}" is ambiguous — ${byName.length} skills match. Pass the full id instead:\n${list}`,
  );
}
