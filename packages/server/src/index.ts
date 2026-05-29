import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  scan,
  groupByName,
  enableSkill,
  disableSkill,
  removeSkill,
  snapshotSkill,
  rollbackSkill,
  getHistory,
  analyzeMerge,
  mergeSkill,
  mergeSkillToCanonical,
  mergeAllSafe,
  getMergeDiff,
  defaultCanonicalRoot,
  migrateOpenclawScopeNames,
  migrateProjectScopeNames,
  readProjects,
  addProject,
  removeProject,
  dismissProjects,
  bootstrapProjects,
  findProjectCandidates,
  SkillWatcher,
  type Skill,
} from '@ai-skillboard/core';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Where the built SPA lives. Two layouts to support:
 *   - Published `@ai-skillboard/server` tarball: `web-dist/` sits next to `src/`
 *     (populated by the package's `prepublishOnly` script).
 *   - Monorepo dev tree: built SPA lives at `packages/web/dist/`.
 * Pick whichever exists at module load; fall back to the monorepo path so the
 * "SPA not built yet" message in `buildServer` still fires correctly.
 */
const SPA_DIST = (() => {
  const inPkg = resolve(here, '..', 'web-dist');
  const inRepo = resolve(here, '..', '..', 'web', 'dist');
  return existsSync(join(inPkg, 'index.html')) ? inPkg : inRepo;
})();

const execFileP = promisify(execFile);

/**
 * Cross-platform "open this path in the OS file manager". macOS → Finder via
 * `open`, Linux → `xdg-open`, Windows → `explorer`.
 *
 * When `select` is true and the path is a file, we ask Finder/Explorer to open
 * the parent dir with the file highlighted (`-R` on macOS, `/select,` on
 * Windows). xdg-open lacks an equivalent, so on Linux we open the parent dir.
 */
async function revealInFileManager(absPath: string, select = false): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileP('open', select ? ['-R', absPath] : [absPath]);
    return;
  }
  if (process.platform === 'win32') {
    if (select) {
      await execFileP('explorer', [`/select,${absPath}`]);
    } else {
      await execFileP('explorer', [absPath]);
    }
    return;
  }
  // Linux: xdg-open has no "select" mode — fall back to opening the parent dir.
  const target = select ? dirname(absPath) : absPath;
  await execFileP('xdg-open', [target]);
}

interface FileNode {
  name: string;
  relPath: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
}

/** Names we never recurse into. Avoids leaking VCS internals + node_modules. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

/** Walk a skill directory and return a sorted tree. */
async function listSkillFiles(root: string): Promise<FileNode[]> {
  async function walk(dir: string, relBase: string): Promise<FileNode[]> {
    let entries: Dirent[];
    try {
      // Cast: Node's overload picks Dirent<Buffer> when not using "encoding",
      // even though we always get string names back at runtime.
      entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[];
    } catch {
      return [];
    }
    const out: FileNode[] = [];
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({
          name: e.name,
          relPath: rel,
          type: 'dir',
          children: await walk(full, rel),
        });
      } else if (e.isFile()) {
        let size: number | undefined;
        try {
          size = (await stat(full)).size;
        } catch {
          /* ignore stat failures */
        }
        out.push({ name: e.name, relPath: rel, type: 'file', size });
      }
      // symlinks / sockets / pipes are skipped — skill directories shouldn't
      // contain them; if they do we silently drop them rather than crash.
    }
    // Dirs first, then files, both alphabetic — typical file-manager order.
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }
  return walk(root, '');
}

export interface BuildServerOptions {
  /** Override the project cwd used when resolving project-scope skills. */
  cwd?: string;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const cwd = opts.cwd ?? process.cwd();
  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });

  // Bootstrap the projects list: if there's no `~/.skillboard/projects.json` yet,
  // seed it with the server's cwd (if it looks like a project) so users
  // upgrading don't lose access to their existing project-scope skills.
  const boot = await bootstrapProjects(cwd);
  if (boot.created) {
    // eslint-disable-next-line no-console
    console.log(
      boot.seeded
        ? `[bootstrap] seeded projects.json with ${cwd}`
        : '[bootstrap] created empty projects.json',
    );
  }

  // One-time migrations: rename version repos to match the new id formats.
  const ocMigration = await migrateOpenclawScopeNames();
  if (ocMigration.renamed.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[migrate] renamed ${ocMigration.renamed.length} openclaw version repos`);
  }
  const projMigration = await migrateProjectScopeNames();
  if (projMigration.renamed.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[migrate] renamed ${projMigration.renamed.length} project-scope version repos with project label`);
  }
  for (const skip of [...ocMigration.skipped, ...projMigration.skipped]) {
    // eslint-disable-next-line no-console
    console.warn(`[migrate] skipped ${skip.name}: ${skip.reason}`);
  }

  // --- Auto-snapshot watcher ---
  //
  // Watches every writable skill's physical dir and snapshots on external
  // edits. Re-synced after every mutating endpoint (action paths may change),
  // and on a 30s timer to pick up brand-new skills that appear on disk
  // without going through skillboard's own action endpoints.
  const watcher = new SkillWatcher({
    onSnapshot: (skill, result) => {
      if (result.changed) {
        // eslint-disable-next-line no-console
        console.log(`[watcher] external-edit snapshot ${skill.id} → ${result.commit?.slice(0, 7)}`);
      }
    },
    onError: (skill, err) => {
      // eslint-disable-next-line no-console
      console.error(`[watcher] snapshot failed for ${skill.id}:`, err.message);
    },
  });
  const syncWatcher = async (): Promise<void> => {
    try {
      const { skills } = await scan({ cwd });
      await watcher.sync(skills);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[watcher] sync failed:', (err as Error).message);
    }
  };
  await syncWatcher();
  const syncInterval = setInterval(() => void syncWatcher(), 30_000);
  app.addHook('onClose', async () => {
    clearInterval(syncInterval);
    await watcher.close();
  });

  // --- Read endpoints ---

  app.get('/api/skills', async () => {
    const result = await scan({ cwd });
    return result;
  });

  app.get('/api/groups', async () => {
    const result = await scan({ cwd });
    return { groups: groupByName(result.skills) };
  });

  app.get<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const skill = await findSkill(req.params.id, cwd);
    if (!skill) return reply.code(404).send({ error: 'skill not found' });
    const skillFileContent = skill.skillFile
      ? await readFile(skill.skillFile, 'utf8').catch(() => null)
      : null;
    return { skill, skillFileContent };
  });

  app.get<{ Params: { id: string } }>('/api/skills/:id/history', async (req) => {
    return { history: await getHistory(decodeURIComponent(req.params.id)) };
  });

  // --- Write endpoints ---

  app.post<{ Params: { id: string } }>('/api/skills/:id/disable', async (req, reply) => {
    const skill = await findSkill(req.params.id, cwd);
    if (!skill) return reply.code(404).send({ error: 'skill not found' });
    const result = await disableSkill(skill);
    await syncWatcher();
    return result;
  });

  app.post<{ Params: { id: string } }>('/api/skills/:id/enable', async (req, reply) => {
    const skill = await findSkill(req.params.id, cwd);
    if (!skill) return reply.code(404).send({ error: 'skill not found' });
    const result = await enableSkill(skill);
    await syncWatcher();
    return result;
  });

  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    '/api/skills/:id/snapshot',
    async (req, reply) => {
      const skill = await findSkill(req.params.id, cwd);
      if (!skill) return reply.code(404).send({ error: 'skill not found' });
      return await snapshotSkill(skill, {
        trigger: 'manual-snapshot',
        userNote: req.body?.message,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { commit: string } }>(
    '/api/skills/:id/rollback',
    async (req, reply) => {
      const skill = await findSkill(req.params.id, cwd);
      if (!skill) return reply.code(404).send({ error: 'skill not found' });
      if (!req.body?.commit) return reply.code(400).send({ error: 'missing commit' });
      return await rollbackSkill(skill, req.body.commit);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const skill = await findSkill(req.params.id, cwd);
    if (!skill) return reply.code(404).send({ error: 'skill not found' });
    const result = await removeSkill(skill);
    await syncWatcher();
    return result;
  });

  app.post<{ Params: { id: string }; Querystring: { target?: 'real' | 'entry' } }>(
    '/api/skills/:id/reveal',
    async (req, reply) => {
      const skill = await findSkill(req.params.id, cwd);
      if (!skill) return reply.code(404).send({ error: 'skill not found' });
      // Default to opening the underlying real directory — that's where edits
      // happen. `target=entry` opens the symlink location instead (useful when
      // debugging which scope a symlink came from).
      const target = req.query?.target === 'entry' ? skill.path : skill.realPath;
      await revealInFileManager(target);
      return { opened: target };
    },
  );

  app.get<{ Params: { id: string } }>('/api/skills/:id/files', async (req, reply) => {
    const skill = await findSkill(req.params.id, cwd);
    if (!skill) return reply.code(404).send({ error: 'skill not found' });
    const files = await listSkillFiles(skill.realPath);
    return { root: skill.realPath, files };
  });

  app.post<{ Params: { id: string }; Body: { relativePath?: string } }>(
    '/api/skills/:id/reveal-file',
    async (req, reply) => {
      const skill = await findSkill(req.params.id, cwd);
      if (!skill) return reply.code(404).send({ error: 'skill not found' });
      const rel = (req.body?.relativePath ?? '').trim();
      // Reject absolute paths and any traversal segments before resolving —
      // path.resolve would happily climb out of the skill dir otherwise.
      if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        return reply.code(400).send({ error: 'invalid relativePath' });
      }
      const resolved = resolve(skill.realPath, rel);
      const within = relative(skill.realPath, resolved);
      if (within.startsWith('..') || isAbsolute(within)) {
        return reply.code(400).send({ error: 'path escapes skill directory' });
      }
      try {
        const s = await stat(resolved);
        // Files get "-R / /select," so Finder/Explorer highlights them inside
        // the parent dir. Dirs just open in place.
        await revealInFileManager(resolved, s.isFile());
      } catch {
        return reply.code(404).send({ error: 'file not found' });
      }
      return { opened: resolved };
    },
  );

  // --- Projects endpoints ---

  // Build the full projects payload: confirmed list + dismissed list + the
  // candidates that haven't been confirmed or dismissed yet.
  async function buildProjectsPayload() {
    const state = await readProjects();
    const confirmed = new Set(state.projects.map((p) => p.path));
    const dismissed = new Set(state.dismissed.map((d) => d.path));
    const candidates = await findProjectCandidates({
      confirmedPaths: confirmed,
      dismissedPaths: dismissed,
    });
    return {
      projects: state.projects,
      dismissed: state.dismissed,
      candidates,
    };
  }

  app.get('/api/projects', async () => buildProjectsPayload());

  app.post<{ Body: { path?: string; label?: string } }>('/api/projects', async (req, reply) => {
    const path = req.body?.path;
    if (typeof path !== 'string' || !path.trim()) {
      return reply.code(400).send({ error: 'missing path' });
    }
    try {
      const entry = await addProject(path.trim(), { label: req.body?.label });
      await syncWatcher();
      return entry;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Querystring: { path?: string } }>('/api/projects', async (req, reply) => {
    const path = req.query?.path;
    if (typeof path !== 'string' || !path) {
      return reply.code(400).send({ error: 'missing path' });
    }
    const removed = await removeProject(path);
    if (!removed) return reply.code(404).send({ error: 'project not found' });
    await syncWatcher();
    return { removed: true, path };
  });

  app.post<{ Body: { paths?: string[] } }>('/api/projects/dismiss', async (req, reply) => {
    const paths = req.body?.paths;
    if (!Array.isArray(paths)) {
      return reply.code(400).send({ error: 'expected { paths: string[] }' });
    }
    await dismissProjects(paths);
    return buildProjectsPayload();
  });

  app.post('/api/projects/rescan', async () => buildProjectsPayload());

  // --- Merge endpoints ---

  app.get('/api/merge/plan', async () => {
    const result = await scan({ cwd });
    const canonical = defaultCanonicalRoot();
    const plans = await analyzeMerge(result.skills, canonical);
    return { canonicalRoot: canonical, plans };
  });

  app.get<{ Params: { name: string } }>('/api/merge/:name/diff', async (req, reply) => {
    try {
      return await getMergeDiff(decodeURIComponent(req.params.name));
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { name: string }; Body: { winnerRealPath?: string } }>(
    '/api/merge/:name',
    async (req, reply) => {
      try {
        const result = await mergeSkill(decodeURIComponent(req.params.name), {
          winnerRealPath: req.body?.winnerRealPath,
        });
        await syncWatcher();
        return result;
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { name: string }; Body: { winnerRealPath?: string } }>(
    '/api/merge/:name/to-canonical',
    async (req, reply) => {
      try {
        const result = await mergeSkillToCanonical(decodeURIComponent(req.params.name), {
          winnerRealPath: req.body?.winnerRealPath,
        });
        await syncWatcher();
        return result;
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post('/api/merge/safe-all', async () => {
    const results = await mergeAllSafe();
    await syncWatcher();
    return { merged: results.map((r) => ({ name: r.name, winner: r.winner.realPath, replaced: r.replacements.length })) };
  });

  // --- Static SPA ---

  const spaExists = await stat(join(SPA_DIST, 'index.html'))
    .then(() => true)
    .catch(() => false);

  if (spaExists) {
    await app.register(fastifyStatic, { root: SPA_DIST });
    // SPA fallback for client-side routing (any unmatched GET → index.html).
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.get('/', async (_req, reply) => {
      return reply
        .type('text/html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>skillboard</title><body style="font-family:system-ui;padding:2rem;max-width:60ch;line-height:1.5">
<h1>skillboard</h1>
<p>The SPA bundle hasn't been built yet. Run:</p>
<pre>npm run web:build</pre>
<p>then restart the server. Meanwhile, the API is live at <a href="/api/skills">/api/skills</a>.</p></body>`,
        );
    });
  }

  return app;
}

async function findSkill(id: string, cwd: string): Promise<Skill | null> {
  const decoded = decodeURIComponent(id);
  const result = await scan({ cwd });
  return result.skills.find((s) => s.id === decoded) ?? null;
}
