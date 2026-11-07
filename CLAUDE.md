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
- Layer lint: `layerBoundaryRules()` in `eslint-config` warns on edge-to-service, service-to-manager,
  client-to-manager/service and library-to-manager/service/client imports. Put it LAST in the app's
  config (flat config does not merge `no-restricted-imports`) and pass the app's own patterns as
  `extraPatterns`. It matches by file and import name, so an app with another layout passes
  `globs` and `imports`; barrel re-exports bypass it, so a green lint is not proof boundaries hold.
