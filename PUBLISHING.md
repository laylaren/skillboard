# Publishing ai-skillboard to npm

Three packages publish to npm; one stays private:

| Package | npm name | publishes? |
| --- | --- | --- |
| packages/core | `@ai-skillboard/core` | yes |
| packages/server | `@ai-skillboard/server` | yes (bundles the built SPA in `web-dist/`) |
| packages/cli | `ai-skillboard` | yes (the `npx ai-skillboard` entrypoint) |
| packages/web | `@ai-skillboard/web` | no (`private: true`; its build ships inside server) |

> Architecture note: the published packages ship TypeScript **source** and run it
> at runtime via `tsx` (a runtime dependency of the CLI). This works and keeps the
> build simple, but consumers download `tsx` + raw `.ts`. If you later want a more
> conventional package, precompile to JS, point `main`/`exports`/`bin` at `dist/`,
> and move `tsx` to `devDependencies`. Not required to publish today.

---

## 0. One-time setup

- [ ] Have an npm account and log in: `npm login` → verify with `npm whoami`.
- [ ] (Recommended) Enable 2FA for publish on your npm account.
- [ ] **Create the `ai-skillboard` npm org.** The scope `@ai-skillboard` is NOT your
      username (`laylaren`), so the scoped packages can only be published if you own
      an org by that exact name. Create it (free for public packages) at
      <https://www.npmjs.com/org/create>.
      - Alternative if you don't want an org: rename the scoped packages to
        `@laylaren/*` (your username scope works automatically), or drop the scope.
      - The unscoped `ai-skillboard` (the CLI) needs no org.

## 1. Pre-flight (every release)

- [ ] Working tree clean, on `main`, pushed.
- [ ] Decide the version and bump all three packages together (keep them in lockstep):
      currently `0.1.0`. The CLI's `--version` reads `package.json`, so no separate
      edit is needed there.
      - `npm version <patch|minor|major> --workspaces --no-git-tag-version` bumps all,
        or edit each `package.json` by hand.
- [ ] `npm run typecheck` passes (`tsc -b`).
- [ ] **Build the web SPA**: `npm run web:build`. The server's `prepack` copies
      `packages/web/dist` → `packages/server/web-dist`; if the SPA isn't built, the
      published server ships a stale/empty dashboard.

## 2. Inspect what will ship (no upload)

Run a dry-run per package and confirm `src/`, `README.md`, `LICENSE`, and
(for server) `web-dist/` are present and there's no junk:

```bash
npm pack --dry-run -w @ai-skillboard/core
npm pack --dry-run -w @ai-skillboard/server
npm pack --dry-run -w ai-skillboard
```

- [ ] core ships all of `src/**` (it runs as TS at runtime).
- [ ] server ships `src/**` AND a freshly built `web-dist/index.html`.
- [ ] cli ships `bin/ai-skillboard.mjs` + `src/**`.

## 3. Publish (order matters)

Publish dependencies first so `npx ai-skillboard` can resolve them on install.
All three already declare `publishConfig.access: public`, so no `--access` flag is
needed.

```bash
npm publish -w @ai-skillboard/core
npm publish -w @ai-skillboard/server      # after web:build
npm publish -w ai-skillboard
```

- [ ] core published.
- [ ] server published (depends on `@ai-skillboard/core@^0.1.0`).
- [ ] cli published (depends on both above).

## 4. Verify from a clean environment

```bash
cd "$(mktemp -d)"
npx ai-skillboard@latest --version     # should print the version you released
npx ai-skillboard@latest ls            # lists skills on this machine
npx ai-skillboard@latest serve         # dashboard at http://127.0.0.1:7300
```

- [ ] `npx ai-skillboard` runs without `ERR_PACKAGE_PATH_NOT_EXPORTED` or missing-dep errors.

## 5. Tag the release

```bash
git tag v0.1.0
git push origin v0.1.0
```

- [ ] (Optional) Cut a GitHub release at <https://github.com/laylaren/skillboard/releases>.

---

## Gotchas

- The bin launcher resolves tsx via the public `tsx/cli` export. Do not revert it to
  `tsx/dist/cli.mjs` — newer tsx versions hide that internal path behind their
  `exports` map and it throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- `packages/web` is `private: true` on purpose. Never `npm publish` it; its bundle is
  copied into `@ai-skillboard/server` by that package's `prepack`.
- `npm audit` currently reports a couple of moderate advisories in the dev/build
  chain. Optional to address before release; they don't ship to runtime consumers of
  the published TS.
- Brand, the `~/.skillboard` data dir, the GitHub repo, and these docs intentionally
  stay named "skillboard" — only the npm identifiers are `ai-skillboard`.
