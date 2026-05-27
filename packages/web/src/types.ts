// Mirror of the core's public types — kept locally so the web bundle doesn't
// drag in the core runtime deps. Keep in sync with packages/core/src/types.ts.

export type AgentId = 'claude-code' | 'cursor' | 'openclaw' | 'codex';
export type Scope = 'user' | 'project' | 'workspace' | 'system';

export interface Skill {
  id: string;
  name: string;
  agent: AgentId;
  scope: Scope;
  path: string;
  /** Fully resolved physical path; equals `path` when not a symlink. */
  realPath: string;
  disabled: boolean;
  skillFile: string | null;
  frontmatter: Record<string, unknown>;
  contentSha: string | null;
  readOnly: boolean;
  scopeLabel: string;
  scopePriority: number;
  projectLabel: string | null;
  projectPath: string | null;
  loaded: boolean;
}

export interface ScopeRoot {
  agent: AgentId;
  scope: Scope;
  root: string;
  readOnly: boolean;
  label: string;
  priority: number;
  projectLabel: string | null;
  projectPath: string | null;
}

export interface ProjectEntry {
  path: string;
  label: string;
  addedAt: string;
}

export interface DismissedEntry {
  path: string;
  dismissedAt: string;
}

export interface ProjectCandidate {
  path: string;
  basename: string;
  hasClaudeCode: boolean;
  hasCursor: boolean;
  hasCodex: boolean;
}

export interface ProjectsPayload {
  projects: ProjectEntry[];
  dismissed: DismissedEntry[];
  candidates: ProjectCandidate[];
}

export interface ScanResult {
  skills: Skill[];
  scopes: ScopeRoot[];
  warnings: string[];
}

export interface FileNode {
  name: string;
  /** Path relative to the skill's realPath. Empty string for the root. */
  relPath: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
}

export interface HistoryEntry {
  commit: string;
  timestamp: string;
  subject: string;
  meta: Record<string, unknown> | null;
}

export interface MergeCandidate {
  realPath: string;
  mtime: string;
  sizeBytes: number;
  fileCount: number;
  dirSha: string;
  members: Skill[];
  inCanonicalRoot: boolean;
}

export type SafeHybridAction =
  | 'silent-merge'
  | 'diff-then-pick'
  | 'no-canonical'
  | 'ambiguous-canonical';

export interface MergePlanItem {
  name: string;
  candidates: MergeCandidate[];
  contentsIdentical: boolean;
  newestWinner: MergeCandidate | null;
  canonicalWinner: MergeCandidate | null;
  hasCanonicalCandidate: boolean;
  safeHybridAction: SafeHybridAction;
}

export interface MergePlanResponse {
  canonicalRoot: string;
  plans: MergePlanItem[];
}

export type FileDiffStatus = 'same' | 'changed' | 'only-in-a' | 'only-in-b';

export interface FileDiffEntry {
  path: string;
  status: FileDiffStatus;
  unifiedDiff?: string;
  binary?: boolean;
}

export interface MergeDiff {
  plan: MergePlanItem;
  a: MergeCandidate;
  b: MergeCandidate;
  files: FileDiffEntry[];
  summary: { same: number; changed: number; onlyInA: number; onlyInB: number };
}
