# @zeyolabs/kit

Shared server toolkit for SvelteKit 3 on Cloudflare Workers: remote-function wrappers
(`Remote.Query/Cmd/Form`), errors and results, the per-request Cloudflare context
(`runWithContext`, `workersEnv`), rate limiting, Turnstile, logging and monitoring, storage
clients, utils, and the shared ESLint config.

Published as source (TypeScript, no build step): the consuming SvelteKit app compiles it.

## Install

```
pnpm add -E @zeyolabs/kit
```

Peer dependencies: `@sveltejs/kit` 3, `drizzle-orm`, `zod`, `@sentry/sveltekit`; `eslint`,
`vitest`, `@electric-sql/pglite` and `@cloudflare/workers-types` only for the parts that use them.

## Versions

Date versions: `YYYY.M.D` (the release day in London; semver forbids leading zeros, so
`2026.11.5`). One release per day.

```
pnpm release                     # sets the version, commits, tags vYYYY.M.D
git push origin HEAD vYYYY.M.D   # the tag publishes to npm (publish.yaml)
```

Publishing uses npm trusted publishing: the package's npmjs.com settings trust this repo's
`publish.yaml`, so no npm token is stored anywhere.

## Developing against an app

`pnpm link ../kit` in the app while working on both; publish, then pin the new version.

## Checks

`pnpm check`: prettier, eslint, `tsc` (source, not tests), vitest.
