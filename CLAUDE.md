# CLAUDE.md

`@zeyolabs/kit`: shared, project-agnostic server toolkit for SvelteKit 3 on Cloudflare
Workers. Used by `@zeyolabs/ui`, `@zeyolabs/shopping` and apps (Pure Leaves).

- Nothing project-specific goes here (no brand, no site names, no secret values).
- Shipped as source: exports point at `.ts` files; the app's Vite build compiles them. Keep every
  `exports` path working, and add new public files to both `exports` and `files`.
- Workers runtime only at runtime: no Node APIs outside tooling (`eslint-config.js`, tests).
- Kit 3: a file with a `remote` segment in its name is a remote module, so the wrappers live in
  `server/remote-functions.ts`. Bindings come from `cloudflare/workers-env.ts`
  (`cloudflare:workers`), never `event.platform`.
- Dependency versions are exact; `@sveltejs/kit`, `drizzle-orm`, `zod` and `@sentry/sveltekit` are
  peers so the app's single copy is used.
- Merging to `main` publishes a new `YYYY.M.N` version automatically (see README). Never tag or
  publish by hand.
- D1 tests: `cloudflare/d1/testing.ts` (`createD1TestDb`, `mockD1`) runs a real D1 on Miniflare. An app
  wraps it once in `tests/db.ts` (its schema, migrations, fixtures) and tests call that `mockDb()`.
  The `undici` and `sharp` overrides in `pnpm-workspace.yaml` only apply inside this repo, so an app
  that adds `miniflare` must set the same overrides (`undici` 7.30.1 or newer, `sharp` 0.35.5).
