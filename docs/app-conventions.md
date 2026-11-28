# App conventions

Rules every app on `@zeyolabs/*` (SvelteKit 3 on Cloudflare Workers, D1, Drizzle) follows. An app's
own `CLAUDE.md` holds only what is specific to it.

## Tooling

- pnpm 11, Node 24. Dependency versions live **once** in the `catalog:` block of `pnpm-workspace.yaml`,
  exact-pinned; reference them as `"catalog:"`.
- Tabs, single quotes, 100 columns (Prettier). LF line endings (`.gitattributes`).
- `pnpm check` is prettier, eslint, svelte-check and tests. Run it before opening a PR.

## Data

- Money is integer pence. Timestamps are epoch milliseconds (UTC) in D1.
- Never write `delete` or `update` without `where` (enforced by `eslint-plugin-drizzle`).
- Migrations: edit the schema, run `db:generate`, apply locally with `db:migrate:local`, commit the
  generated folder. Never run remote migrations by hand.

## Bindings and secrets

- Bindings are ambient: `hooks.server.ts` wraps each request in `runWithContext`, so server code reads
  `getDb()`, `env()` and `envStore()`. Never thread `platform.env` or import `event.platform`.
- Secrets Store bindings are listed once in `Secrets` (`core/secrets.ts`, a `CloudflareSecrets`), and
  every entry point calls `EnvStore.configure(Secrets)` at module scope.
- Secrets never go in the repo: `.env` locally, the Secrets Store in production.

## SvelteKit 3

- Config lives in each app's `vite.config.ts` through `AppVite.config` (no `svelte.config.js`).
- Fonts are self-hosted and chosen by each app: import them in `app.css` (e.g. `@fontsource`) and
  set `--font-sans` / `--font-mono`. The CSP allows fonts only from the app's own origin, so no
  Google Fonts `<link>` in `app.html`.
- App imports use `#lib/...` with the file extension; use `$app/env`, not `$app/environment`.
- `resolve('shop')` takes no leading slash for plain paths.
- Server actions are remote functions (`Remote.Form/Query/Cmd` from `@zeyolabs/kit/server/remote-functions`),
  used as described in `sveltekit-remote.md`. Public forms are rate limited and gated with Turnstile
  inside a manager.
- Svelte 5 runes only. UI used by more than one page belongs in `@zeyolabs/ui`, not copy-pasted.

## Changing a shared package

App-specific code never goes in `@zeyolabs/*`: the brand lives in `packages/brand`, site config and
wording in `packages/core` and the apps. To change a package, edit it in its repo and merge: a merge
to `main` publishes to npm (a docs-only change does not; run the Publish workflow). Then bump the
version in the app's catalog.
