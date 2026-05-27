export type AgentId = 'claude-code' | 'cursor' | 'openclaw' | 'codex';

/**
 * Logical scope of a skill. `user` / `project` cover claude-code, cursor, codex
 * (which have a clear per-cwd vs global split). openclaw doesn't fit that model
 * — both of its dirs live under `~`, just at different layers — so we tag those
 * `workspace` (`~/.openclaw/workspace/skills/`) and `system` (`~/.openclaw/skills/`).
 */
export type Scope = 'user' | 'project' | 'workspace' | 'system';

export interface ScopeRoot {
  agent: AgentId;
  scope: Scope;
  /** Absolute filesystem path to the directory that contains one-subdirectory-per-skill. */
  root: string;
  /** True if this scope is read-only (plugin-bundled skills). */
  readOnly: boolean;
  /** Human label, e.g. "claude-code · user" or "claude-code · project · my-app". */
  label: string;
  /**
   * Agent's load priority for this scope. Higher wins when multiple scopes
   * within the same agent contain a skill with the same name — that copy is
   * the one actually loaded at runtime; others are shadowed.
   */
  priority: number;
  /**
   * For project-scoped roots: which configured project this scope belongs to.
   * `null` for user / workspace / system scopes. The label is incorporated into
   * skill ids so two projects can each have a skill called "foo" without
   * colliding.
   */
  projectLabel: string | null;
  /** Absolute filesystem path of the project root (`null` if not project-scoped). */
  projectPath: string | null;
}

export interface SkillFrontmatter {
  name?: string;
  version?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Skill {
  /** Stable id of the form `<agent>:<scope>:<name>` (or fallback `<agent>:<scope>:<dirname>`). */
  id: string;
  /** Resolved skill name — from frontmatter if present, else directory name. */
  name: string;
  agent: AgentId;
  scope: Scope;
  /** Absolute path to the skill's directory (may be a symlink). */
  path: string;
  /**
   * Fully resolved physical path (symlinks followed). Equals `path` when not a
   * symlink. Two skills with the same `realPath` are the same file on disk —
   * conflict detection should dedupe by this, not by `path`.
   */
  realPath: string;
  /** Whether the skill is currently considered disabled (lives under a `.disabled/` segment). */
  disabled: boolean;
  /** Absolute path to the SKILL.md file, if one was found. */
  skillFile: string | null;
  /** Parsed frontmatter from SKILL.md (empty object if none). */
  frontmatter: SkillFrontmatter;
  /** SHA-256 of the SKILL.md file contents (hex, first 12 chars). null if no SKILL.md. */
  contentSha: string | null;
  /** True if the scope this skill came from is read-only. */
  readOnly: boolean;
  /** Human-readable label for the source scope, e.g. "claude-code · user". */
  scopeLabel: string;
  /** Mirror of the source `ScopeRoot.priority`. */
  scopePriority: number;
  /** For project-scoped skills: the project label this skill belongs to (else null). */
  projectLabel: string | null;
  /** For project-scoped skills: the absolute project root path (else null). */
  projectPath: string | null;
  /**
   * Is this entry the one actually loaded by its agent at runtime?
   * Within an agent, a single name is "loaded" only at the highest-priority scope.
   * For uncontested names this is always true.
   */
  loaded: boolean;
}

/**
 * Skills with the same `name` aggregated across agents/scopes — used for
 * conflict detection and the "which copy is actually loaded" decision.
 */
export interface SkillGroup {
  name: string;
  members: Skill[];
}

export interface ScanOptions {
  /**
   * Legacy single-project knob. If `projectRoots` is unset, the scanner will
   * fall back to `[{ path: cwd, label: basename(cwd) }]`. Most callers should
   * leave this unset and rely on the per-user `projects.json` instead.
   */
  cwd?: string;
  /** Override the home directory (mostly for testing). */
  home?: string;
  /** Restrict scan to specific agents. */
  agents?: AgentId[];
  /**
   * Explicit list of project roots to scan. When provided, the cwd-based
   * adapters (claude-code, cursor, codex) emit one project-scope-root per
   * entry. When unset, the scanner reads `~/.one-skill/projects.json`.
   * Pass an empty array to suppress project-scope scanning entirely.
   */
  projectRoots?: { path: string; label: string }[];
}

export interface ScanResult {
  skills: Skill[];
  scopes: ScopeRoot[];
  /** Errors encountered while reading individual skill files; non-fatal. */
  warnings: string[];
}
