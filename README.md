# one-skill

> A local dashboard for inspecting and managing skills across Claude Code, Codex, Cursor, and openclaw — in one place.

[简体中文](./README.zh-CN.md)

![one-skill dashboard](./docs/screenshot.png)

## What it does

- **Cross-agent inventory** — scans `~/.claude/skills`, `~/.codex/pets`, `~/.cursor/skills-cursor`, `~/.openclaw/skills`, plus any per-project `.claude/skills/` directories you opt into.
- **Spots duplicates and shadows** — when the same skill name lives in multiple agents or scopes, the dashboard tells you which copy is actually loaded and where the others differ.
- **Safe merge** — for identical-contents conflicts, collapses copies into a single canonical source via symlinks, with full undo via the trash.
- **Version history out of the box** — every external edit, install, enable, disable, or manual snapshot is captured in a per-skill git repo under `~/.one-skill/versions/`. Rollback in one click.

## Quick start

```bash
git clone https://github.com/<your-github>/one-skill.git
cd one-skill
npm install      # the `prepare` hook auto-builds the SPA bundle
npm run serve    # → ✓ one-skill dashboard at http://127.0.0.1:7300
```

Then open <http://127.0.0.1:7300> in a browser. The CLI flag `--no-open` skips the auto-open behaviour, `--port <n>` (default 7300) lets you change the port.

## Install via npm

Once published, you'll be able to run it without cloning:

```bash
npx one-skill
```

(Not on npm yet — track [the issue tracker](https://github.com/<your-github>/one-skill/issues) for release news.)

## Supported agents

| Agent       | User scope                       | Project / workspace scope         |
| ----------- | -------------------------------- | --------------------------------- |
| Claude Code | `~/.claude/skills/`              | `<project>/.claude/skills/`       |
| Codex       | `~/.codex/pets/`                 | `<project>/.codex/pets/`          |
| Cursor      | `~/.cursor/skills-cursor/`       | `<project>/.cursor/skills-cursor/`|
| openclaw    | `~/.openclaw/skills/` (`system`) | `~/.openclaw/workspace/skills/` (`workspace`) |

Claude Code's plugin-bundled skills under `~/.claude/plugins/cache/.../skills/` are shown read-only — modifications belong to `/plugin`.

## Where data is stored

All of one-skill's local state lives under `~/.one-skill/`:

- `~/.one-skill/projects.json` — projects you've opted into scanning
- `~/.one-skill/versions/` — per-skill bare git repos for history
- `~/.one-skill/trash/` — safety net for removed skills

There is no telemetry, no network call beyond what the browser does to `127.0.0.1`, and no account.

## Development

```bash
npm run web:dev    # Vite dev server with HMR (terminal 1)
npm run serve      # Fastify API (terminal 2) — proxy from the Vite server or run prod build
npm run typecheck  # tsc -b across all workspaces
```

The repo is an npm workspaces monorepo:

- `packages/core` — scanner, adapters (one per agent), versioning, file watcher
- `packages/server` — Fastify REST + static SPA host
- `packages/web` — React SPA (built artifact ships inside `@one-skill/server` on publish)
- `packages/cli` — the `one-skill` binary

## Contributing

Issues and PRs welcome. There's no formal `CONTRIBUTING.md` yet; the codebase is small enough to read end-to-end in an afternoon.

## License

[MIT](./LICENSE)
