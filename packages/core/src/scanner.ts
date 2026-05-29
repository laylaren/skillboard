import { homedir } from 'node:os';
import { join, sep, basename } from 'node:path';
import { readdir, stat, realpath } from 'node:fs/promises';
import { adapters as defaultAdapters } from './adapters/index.js';
import { parseSkillFile } from './frontmatter.js';
import { readProjects } from './projects.js';
import type {
  AgentId,
  ScanOptions,
  ScanResult,
  Skill,
  ScopeRoot,
  SkillGroup,
} from './types.js';

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk a single scope root.
 *
 * Layout assumption: each immediate subdirectory of `root` is one skill.
 * Some roots may also contain a sibling `.disabled/<name>/` tree — those
 * subdirectories are surfaced too, but marked `disabled: true`.
 */
async function scanScope(scope: ScopeRoot, warnings: string[]): Promise<Skill[]> {
  if (!(await isDirectory(scope.root))) return [];

  const skills: Skill[] = [];

  // Walk both the live root and any `.disabled/` sibling within the same scope.
  const candidates: { dir: string; disabled: boolean }[] = [
    { dir: scope.root, disabled: false },
    { dir: join(scope.root, '.disabled'), disabled: true },
  ];

  for (const { dir, disabled } of candidates) {
    if (!(await isDirectory(dir))) continue;

    let entries: string[];
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      // Accept real dirs AND symlinks (skill directories are sometimes symlinked
      // into `~/.claude/skills/`). For symlinks we resolve via stat() below.
      const candidates = dirents
        .filter((d) => !d.name.startsWith('.') && (d.isDirectory() || d.isSymbolicLink()))
        .map((d) => d.name);
      entries = [];
      for (const name of candidates) {
        if (await isDirectory(join(dir, name))) entries.push(name);
      }
    } catch (err) {
      warnings.push(`readdir failed: ${dir} — ${(err as Error).message}`);
      continue;
    }

    for (const dirname of entries) {
      const skillPath = join(dir, dirname);
      const skillFile = await findSkillFile(skillPath);

      let frontmatter = {};
      let contentSha: string | null = null;
      if (skillFile) {
        try {
          const parsed = await parseSkillFile(skillFile);
          frontmatter = parsed.frontmatter;
          contentSha = parsed.contentSha;
        } catch (err) {
          warnings.push(`parse failed: ${skillFile} — ${(err as Error).message}`);
        }
      }

      const fmName = typeof (frontmatter as { name?: unknown }).name === 'string'
        ? ((frontmatter as { name: string }).name)
        : null;
      const resolvedName = fmName ?? dirname;

      // Resolve symlinks so the conflict detector and the UI can tell when
      // multiple entries are really the same file on disk.
      const realPath = await realpath(skillPath).catch(() => skillPath);

      // Project-scoped ids include the project label so two projects can each
      // host a "foo" skill without their version-history repos colliding.
      const id = scope.projectLabel
        ? `${scope.agent}:${scope.scope}:${scope.projectLabel}:${resolvedName}`
        : `${scope.agent}:${scope.scope}:${resolvedName}`;

      skills.push({
        id,
        name: resolvedName,
        agent: scope.agent,
        scope: scope.scope,
        path: skillPath,
        realPath,
        disabled,
        skillFile,
        frontmatter,
        contentSha,
        readOnly: scope.readOnly,
        scopeLabel: scope.label,
        scopePriority: scope.priority,
        projectLabel: scope.projectLabel,
        projectPath: scope.projectPath,
        // Filled in after the full scan, once we know per-agent priorities.
        loaded: false,
      });
    }
  }

  return skills;
}

/** Skills can be authored with `SKILL.md` or `skill.md` (lowercase). Pick whichever exists. */
async function findSkillFile(skillPath: string): Promise<string | null> {
  for (const candidate of ['SKILL.md', 'skill.md']) {
    const p = join(skillPath, candidate);
    try {
      if ((await stat(p)).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export async function scan(options: ScanOptions = {}): Promise<ScanResult> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const agentFilter: Set<AgentId> | null = options.agents
    ? new Set(options.agents)
    : null;

  // Resolve which project roots feed the cwd-based adapters.
  // Caller-provided list wins; otherwise we read `~/.skillboard/projects.json`;
  // legacy callers that pass nothing get the current cwd as a one-off project.
  let projectRoots: { path: string; label: string }[];
  if (options.projectRoots) {
    projectRoots = options.projectRoots;
  } else {
    const state = await readProjects(home);
    if (state.projects.length > 0) {
      projectRoots = state.projects.map((p) => ({ path: p.path, label: p.label }));
    } else if (options.cwd) {
      projectRoots = [{ path: cwd, label: basename(cwd) }];
    } else {
      projectRoots = [];
    }
  }

  const warnings: string[] = [];
  const allScopes: ScopeRoot[] = [];
  const allSkills: Skill[] = [];

  for (const adapter of defaultAdapters) {
    if (agentFilter && !agentFilter.has(adapter.agent)) continue;

    let scopes: ScopeRoot[];
    try {
      scopes = await adapter.resolveScopes({ projectRoots, home });
    } catch (err) {
      warnings.push(`adapter ${adapter.agent} failed to resolve scopes: ${(err as Error).message}`);
      continue;
    }

    for (const scope of scopes) {
      allScopes.push(scope);
      const skills = await scanScope(scope, warnings);
      allSkills.push(...skills);
    }
  }

  markLoaded(allSkills);

  return { skills: allSkills, scopes: allScopes, warnings };
}

/**
 * Within each (agent, name) group, exactly one entry is "loaded" by the agent
 * at runtime — the one in the highest-priority scope. All others are shadowed.
 * Disabled entries are never considered loaded.
 */
function markLoaded(skills: Skill[]): void {
  const byAgentName = new Map<string, Skill[]>();
  for (const s of skills) {
    const key = `${s.agent}::${s.name}`;
    const arr = byAgentName.get(key) ?? [];
    arr.push(s);
    byAgentName.set(key, arr);
  }
  for (const group of byAgentName.values()) {
    const live = group.filter((s) => !s.disabled);
    if (live.length === 0) continue;
    const winner = live.reduce((a, b) => (b.scopePriority > a.scopePriority ? b : a));
    winner.loaded = true;
  }
}

export function groupByName(skills: Skill[]): SkillGroup[] {
  const map = new Map<string, Skill[]>();
  for (const skill of skills) {
    const arr = map.get(skill.name) ?? [];
    arr.push(skill);
    map.set(skill.name, arr);
  }
  return [...map.entries()]
    .map(([name, members]) => ({ name, members }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Count the number of distinct *physical* skills in a group. Symlinks that
 * resolve to the same path are deduped — so three rows pointing at one source
 * dir count as 1, not 3.
 */
export function distinctRealPaths(group: SkillGroup): number {
  return new Set(group.members.map((m) => m.realPath)).size;
}

/** True when the group represents 2+ physically distinct skills with the same name. */
export function isRealConflict(group: SkillGroup): boolean {
  return distinctRealPaths(group) >= 2;
}

export function shortenPath(p: string, home: string): string {
  if (p === home) return '~';
  if (p.startsWith(home + sep)) return '~' + p.slice(home.length);
  return p;
}
