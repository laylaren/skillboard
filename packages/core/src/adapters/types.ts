import type { AgentId, ScopeRoot } from '../types.js';

export interface AdapterContext {
  /** Project roots configured for this scan. Adapters that have a per-project
   * scope (claude-code, cursor, codex) should emit one ScopeRoot per entry. */
  projectRoots: { path: string; label: string }[];
  /** The user's home dir. */
  home: string;
}

export interface Adapter {
  agent: AgentId;
  /**
   * Enumerate the scope roots this adapter wants the scanner to walk.
   * Each root is a directory containing one-subdirectory-per-skill.
   * Returning a path that doesn't exist on disk is fine — the scanner skips it.
   */
  resolveScopes(ctx: AdapterContext): Promise<ScopeRoot[]>;
}
