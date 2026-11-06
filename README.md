# @zeyolabs/kit

Shared server toolkit for SvelteKit 3 on Cloudflare Workers: remote-function wrappers
(`Remote.Query/Cmd/Form`), errors and results, the per-request Cloudflare context
(`runWithContext`, `workersEnv`), passwordless auth, email (binding or SMTP), rate limiting, Turnstile, logging
and monitoring, storage clients, utils, and the shared ESLint config.

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

## Auth (`@zeyolabs/kit/auth/*`)

Passwordless sign-in: an emailed magic link or a passkey. No passwords anywhere. Sessions are
`<id>.<secret>` cookies (sha256 at rest, 30 days, sliding); magic links are single-use and expire
in 15 minutes; passkeys are verified server-side (ES256/RS256, user verification required).

1. Tables: add `node_modules/@zeyolabs/kit/auth/schema.ts` to the app's drizzle-kit `schema` and
   generate a migration (`users`, `sessions`, `auth_tokens`, `passkeys`).
2. Config, once at module scope (e.g. next to `secretNames`):
   ```ts
   configureAuth({
   	appName: 'My app',
   	db: () => getDb(),
   	email: () => (dev ? new DevEmailClient() : SmtpClient.fromEnv(smtpKeys, { from })),
   	emailBrand: brand,
   	isAllowed: (email) => isEmailAllowed(email, env().ALLOWED_EMAILS),
   });
   ```
3. Hook, after the context handle: `createAuthHandle({ access })` (pass `access` to also require
   a matching Cloudflare Access JWT). Type `App.Locals` as `interface Locals extends AuthLocals`.
4. Routes: `src/routes/auth/[...path]/+server.ts` is
   `export { POST } from '@zeyolabs/kit/auth/routes';`, and the login page's `+page.server.ts` is
   `export { loginLoad as load } from '@zeyolabs/kit/auth/loads';`.
5. The login page (the app's own markup) posts `email` to `/auth/email`; with `?token=` it shows a
   button posting `token` to `/auth/verify` (so mail scanners can't use the link); its passkey
   button calls `signInWithPasskey()` from `@zeyolabs/kit/auth/passkey-client`. A settings page
   uses `passkeysLoad` and `addPasskey(name)`, and posts `id` to `/auth/passkey/delete`.

## Email clients

`IEmailClient` (`deliver` throws, `send` logs and returns `false`) has two transports on
`BaseEmailClient`: `EmailClient` (`cloudflare/email`, a Workers `send_email` binding) and
`SmtpClient` (`cloudflare/email/smtp`, e.g. Amazon SES, any recipient; `SmtpClient.fromEnv(keys, sender)`
reads the settings from the request context). `DevEmailClient` prints instead of sending and
`FakeEmailClient` records messages for tests; both work in place of either transport.

## Developing against an app

`pnpm link ../kit` in the app while working on both; publish, then pin the new version.

## Checks

`pnpm check`: prettier, eslint, `tsc` (source, not tests), vitest.
