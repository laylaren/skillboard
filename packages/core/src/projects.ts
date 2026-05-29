import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolveOneSkillPaths } from './paths.js';

export interface ProjectEntry {
  /** Absolute filesystem path to the project root (the dir that contains `.claude/skills/` etc.). */
  path: string;
  /** Short slug used in skill ids and UI labels. Unique within the projects list. */
  label: string;
  /** ISO timestamp the user confirmed this project. */
  addedAt: string;
}

export interface DismissedEntry {
  path: string;
  dismissedAt: string;
}

export interface ProjectsState {
  version: 1;
  projects: ProjectEntry[];
  dismissed: DismissedEntry[];
}

const EMPTY: ProjectsState = { version: 1, projects: [], dismissed: [] };

function configPath(home?: string): string {
  return join(resolveOneSkillPaths(home).root, 'projects.json');
}

/** Read state from disk. Returns an empty state if the file is missing or unreadable. */
export async function readProjects(home?: string): Promise<ProjectsState> {
  const p = configPath(home);
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as ProjectsState;
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY };
    return {
      version: 1,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Persist state atomically (write to tmp, rename). */
export async function writeProjects(state: ProjectsState, home?: string): Promise<void> {
  const p = configPath(home);
  await mkdir(resolveOneSkillPaths(home).root, { recursive: true });
  await writeFile(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * Turn an arbitrary path into a stable slug used in skill ids and UI labels.
 * Disambiguates against existing labels by suffixing `-2`, `-3`, ... as needed.
 */
export function deriveLabel(path: string, taken: ReadonlySet<string>): string {
  const base = basename(path).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  let candidate = base || 'project';
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

/** Add a project to the confirmed list. Returns the persisted entry. Throws on duplicate path. */
export async function addProject(
  path: string,
  opts: { label?: string; home?: string } = {},
): Promise<ProjectEntry> {
  const state = await readProjects(opts.home);
  if (state.projects.some((p) => p.path === path)) {
    throw new Error(`project already added: ${path}`);
  }
  const taken = new Set(state.projects.map((p) => p.label));
  const label = opts.label?.trim() || deriveLabel(path, taken);
  if (taken.has(label)) throw new Error(`label already in use: ${label}`);

  const entry: ProjectEntry = { path, label, addedAt: new Date().toISOString() };
  state.projects.push(entry);
  // Adding a path removes it from the dismissed list — implicit "un-dismiss".
  state.dismissed = state.dismissed.filter((d) => d.path !== path);
  await writeProjects(state, opts.home);
  return entry;
}

export async function removeProject(path: string, home?: string): Promise<boolean> {
  const state = await readProjects(home);
  const before = state.projects.length;
  state.projects = state.projects.filter((p) => p.path !== path);
  if (state.projects.length === before) return false;
  await writeProjects(state, home);
  return true;
}

/** Add paths to the dismissed list so they stop showing as candidates. */
export async function dismissProjects(paths: string[], home?: string): Promise<void> {
  const state = await readProjects(home);
  const now = new Date().toISOString();
  const existing = new Set(state.dismissed.map((d) => d.path));
  for (const p of paths) {
    if (!existing.has(p)) {
      state.dismissed.push({ path: p, dismissedAt: now });
      existing.add(p);
    }
  }
  await writeProjects(state, home);
}

/**
 * If projects.json doesn't exist yet, create one. If `seedPath` looks like a real
 * project root (has any of the Agent dirs we care about), it's pre-added so that
 * users upgrading don't lose their existing project skills on first launch.
 * Returns the state that's now on disk.
 */
export async function bootstrapProjects(
  seedPath: string,
  home: string = homedir(),
): Promise<{ state: ProjectsState; created: boolean; seeded: boolean }> {
  const p = configPath(home);
  try {
    await stat(p);
    return { state: await readProjects(home), created: false, seeded: false };
  } catch {
    // File doesn't exist — we'll create one.
  }

  const seedHasSkills = await hasAnyAgentDir(seedPath);
  if (seedHasSkills) {
    const label = deriveLabel(seedPath, new Set());
    const state: ProjectsState = {
      version: 1,
      projects: [{ path: seedPath, label, addedAt: new Date().toISOString() }],
      dismissed: [],
    };
    await writeProjects(state, home);
    return { state, created: true, seeded: true };
  }

  await writeProjects({ ...EMPTY }, home);
  return { state: { ...EMPTY }, created: true, seeded: false };
}

async function hasAnyAgentDir(root: string): Promise<boolean> {
  const candidates = [
    join(root, '.claude', 'skills'),
    join(root, '.cursor', 'skills-cursor'),
    join(root, '.codex', 'skills'),
  ];
  for (const p of candidates) {
    try {
      const st = await stat(p);
      if (st.isDirectory()) return true;
    } catch {
      /* continue */
    }
  }
  return false;
}
