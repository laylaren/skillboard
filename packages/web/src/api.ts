import type {
  FileNode,
  HistoryEntry,
  MergeDiff,
  MergePlanResponse,
  ProjectEntry,
  ProjectsPayload,
  ScanResult,
  Skill,
} from './types.js';

async function req<T>(input: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content-type when we're actually sending a body —
  // otherwise Fastify's content-type-parser rejects the empty-body POST with
  // FST_ERR_CTP_EMPTY_JSON_BODY.
  const headers: Record<string, string> = {};
  if (init?.body != null) headers['content-type'] = 'application/json';
  const res = await fetch(input, {
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

export const api = {
  scan: () => req<ScanResult>('/api/skills'),
  detail: (id: string) =>
    req<{ skill: Skill; skillFileContent: string | null }>(
      `/api/skills/${encodeURIComponent(id)}`,
    ),
  history: (id: string) =>
    req<{ history: HistoryEntry[] }>(`/api/skills/${encodeURIComponent(id)}/history`),
  enable: (id: string) =>
    req(`/api/skills/${encodeURIComponent(id)}/enable`, { method: 'POST' }),
  disable: (id: string) =>
    req(`/api/skills/${encodeURIComponent(id)}/disable`, { method: 'POST' }),
  snapshot: (id: string, message?: string) =>
    req(`/api/skills/${encodeURIComponent(id)}/snapshot`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  rollback: (id: string, commit: string) =>
    req(`/api/skills/${encodeURIComponent(id)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ commit }),
    }),
  remove: (id: string) =>
    req(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  reveal: (id: string, target: 'real' | 'entry' = 'real') =>
    req<{ opened: string }>(
      `/api/skills/${encodeURIComponent(id)}/reveal?target=${target}`,
      { method: 'POST' },
    ),
  files: (id: string) =>
    req<{ root: string; files: FileNode[] }>(
      `/api/skills/${encodeURIComponent(id)}/files`,
    ),
  revealFile: (id: string, relativePath: string) =>
    req<{ opened: string }>(
      `/api/skills/${encodeURIComponent(id)}/reveal-file`,
      { method: 'POST', body: JSON.stringify({ relativePath }) },
    ),
  mergePlan: () => req<MergePlanResponse>('/api/merge/plan'),
  mergeDiff: (name: string) =>
    req<MergeDiff>(`/api/merge/${encodeURIComponent(name)}/diff`),
  merge: (name: string, winnerRealPath?: string) =>
    req(`/api/merge/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ winnerRealPath }),
    }),
  mergeSafeAll: () => req<{ merged: { name: string; winner: string; replaced: number }[] }>(
    '/api/merge/safe-all',
    { method: 'POST' },
  ),
  getProjects: () => req<ProjectsPayload>('/api/projects'),
  addProject: (body: { path: string; label?: string }) =>
    req<ProjectEntry>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  removeProject: (path: string) =>
    req<{ removed: boolean; path: string }>(
      `/api/projects?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    ),
  dismissProjects: (paths: string[]) =>
    req<ProjectsPayload>('/api/projects/dismiss', {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),
  rescanProjects: () => req<ProjectsPayload>('/api/projects/rescan', { method: 'POST' }),
};
