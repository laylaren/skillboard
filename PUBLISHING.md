# Publishing skillboard to npm

Three packages publish to npm under the `@laylaren` scope; one stays private:

| Package | npm name | publishes? |
| --- | --- | --- |
| packages/core | `@laylaren/skillboard-core` | yes |
| packages/server | `@laylaren/skillboard-server` | yes (bundles the built SPA in `web-dist/`) |
| packages/cli | `@laylaren/skillboard` | yes (the `npx @laylaren/skillboard` entrypoint; installs a `skillboard` command) |
| packages/web | `@laylaren/skillboard-web` | no (`private: true`; its build ships inside server) |

> The unscoped name `skillboard` on npm is owned by an unrelated author, so we
> publish under the `@laylaren` scope instead. The terminal command is still
> `skillboard` (the package's bin), so a global install gives you `skillboard …`.

> Architecture note: the published packages ship TypeScript **source** and run it
> at runtime via `tsx` (a runtime dependency of the CLI). This works and keeps the
> build simple, but consumers download `tsx` + raw `.ts`. If you later want a more
> conventional package, precompile to JS, point `main`/`exports`/`bin` at `dist/`,
> and move `tsx` to `devDependencies`. Not required to publish today.

---

## 0. One-time setup

- [ ] Logged in to npm as `laylaren`: `npm whoami` should print `laylaren`.
      (The `@laylaren` scope == your username, so no npm org is needed.)
- [ ] (Recommended) Enable 2FA for publish on your npm account.

## 1. Pre-flight (every release)

- [ ] Working tree clean, on `main`, pushed.
- [ ] Decide the version and bump all three packages together (keep them in lockstep):
      currently `0.1.0`. The CLI's `--version` reads `package.json`, so no separate
      edit is needed there.
      - `npm version <patch|minor|major> --workspaces --no-git-tag-version` bumps all,
        or edit each `package.json` by hand.
      - If you bump, also update the `^0.1.0` dependency ranges in
        `packages/server` and `packages/cli` to match.
- [ ] `npm run typecheck` passes (`tsc -b`).
- [ ] **Build the web SPA**: `npm run web:build`. The server's `prepack` copies
      `packages/web/dist` → `packages/server/web-dist`; if the SPA isn't built, the
      published server ships a stale/empty dashboard.

## 2. Inspect what will ship (no upload)

Run a dry-run per package and confirm `src/`, `README.md`, `LICENSE`, and
(for server) `web-dist/` are present and there's no junk:

```bash
npm pack --dry-run -w @laylaren/skillboard-core
npm pack --dry-run -w @laylaren/skillboard-server
npm pack --dry-run -w @laylaren/skillboard
```

- [ ] core ships all of `src/**` (it runs as TS at runtime).
- [ ] server ships `src/**` AND a freshly built `web-dist/index.html`.
- [ ] cli ships `bin/skillboard.mjs` + `src/**`.

## 3. Publish (order matters)

Publish dependencies first so `npx @laylaren/skillboard` can resolve them on install.
All three already declare `publishConfig.access: public` (required for scoped
packages to be public), so no `--access` flag is needed.

```bash
npm publish -w @laylaren/skillboard-core
npm publish -w @laylaren/skillboard-server      # after web:build
npm publish -w @laylaren/skillboard
```

- [ ] core published.
- [ ] server published (depends on `@laylaren/skillboard-core@^0.1.0`).
- [ ] cli published (depends on both above).

## 4. Verify from a clean environment

```bash
cd "$(mktemp -d)"
npx @laylaren/skillboard@latest --version     # should print the version you released
npx @laylaren/skillboard@latest ls            # lists skills on this machine
npx @laylaren/skillboard@latest serve         # dashboard at http://127.0.0.1:7300
```

- [ ] `npx @laylaren/skillboard` runs without `ERR_PACKAGE_PATH_NOT_EXPORTED` or missing-dep errors.

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
  copied into `@laylaren/skillboard-server` by that package's `prepack`.
- `npm audit` currently reports a couple of moderate advisories in the dev/build
  chain. Optional to address before release; they don't ship to runtime consumers of
  the published TS.
- Brand, the `~/.skillboard` data dir, the GitHub repo, the terminal command, and
  these docs intentionally stay named "skillboard" — only the npm package names carry
  the `@laylaren/skillboard*` scope.
