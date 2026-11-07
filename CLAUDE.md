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
- Layers (apps follow `standards/codex`): libraries are objects of static functions, clients talk
  to the outside world, services take `(ctx, db)` and talk to the db, managers are permission
  check, service call, events. `server/layers.ts` has the shared types and `server/manager.ts` the
  permission gate. Nothing here is a base class.
- Dependency versions are exact; `@sveltejs/kit`, `drizzle-orm`, `zod` and `@sentry/sveltekit` are
  peers so the app's single copy is used.
- Merging to `main` publishes a new `YYYY.M.N` version automatically (see README). Never tag or
  publish by hand.
