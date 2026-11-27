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

Every merge to `main` publishes a new version (`.github/workflows/publish.yaml`). There is no
release step. Versions are `YYYY.M.N` in London time: `N` counts that month's releases and resets
each month (`2026.11.7`, `2026.11.8`, then `2026.12.0`). CI sets the version and pushes the
`vYYYY.M.N` tag; `package.json`'s version in the repo is not updated. Changes to only docs or CI
don't publish.

Publishing uses npm trusted publishing: the package's npmjs.com settings trust this repo's
`publish.yaml`, so no npm token is stored anywhere.

## Auth (`@zeyolabs/kit/auth/*`)

Everything in `auth/` is one of the four layers (see `CLAUDE.md`):

- **Services** (take the db, build with `new X(db)`): `SignInService` (`sign-in`: sessions, emailed
  links, passkey credentials, users, and the email-link form with its optional bot check) and
  `AccountService` (`accounts/accounts`: accounts, members, policies and invites).
- **Clients:** `TurnstileClient` (`@zeyolabs/kit/cloudflare/turnstile`); `PasskeyClient` in the browser.
- **Managers:** `SignInManager` (`sign-in-manager`) runs one `/auth/*` request: cookies, redirects and
  the passkey ceremonies. `routes` is only its dispatch table; `loads` has the login, passkey and invite page loads.
- **Libraries** (static functions): `Passkeys` (the WebAuthn checks), `Allowlist`, `Permissions`,
  `AuthEmails`, `Login`, `AuthHandle` and `AccountHandle` (the hooks), and `Auth.configure` for the config.

Passwordless sign-in: an emailed magic link or a passkey. No passwords anywhere. Sessions are
`<id>.<secret>` cookies (sha256 at rest, 30 days, sliding); magic links are single-use and expire
in 15 minutes; passkeys are verified server-side (ES256/RS256, user verification required).

1. Tables: add `node_modules/@zeyolabs/kit/auth/schema.ts` to the app's drizzle-kit `schema` and
   generate a migration (`users`, `sessions`, `auth_tokens`, `passkeys`).
2. Config (`Auth.configure`), once at module scope (e.g. next to `EnvStore.configure(Secrets)`):
   ```ts
   Auth.configure({
   	appName: 'My app',
   	db: () => getDb(),
   	email: () => (dev ? new DevEmailClient() : SmtpClient.fromEnv(envStore(), { from })),
   	emailBrand: brand,
   	isAllowed: (email) => Allowlist.includes(email, env().ALLOWED_EMAILS),
   });
   ```
3. Hook, after the context handle: `AuthHandle.create({ access })` (pass `access` to also require
   a matching Cloudflare Access JWT). Type `App.Locals` as `interface Locals extends AuthLocals`.
4. Routes: `src/routes/auth/[...path]/+server.ts` is
   `export { POST } from '@zeyolabs/kit/auth/routes';`, and the login page's `+page.server.ts` is
   `export const load = AuthLoads.login;` (from `@zeyolabs/kit/auth/loads`).
5. The login page (the app's own markup) posts `email` to `/auth/email`; with `?token=` it shows a
   button posting `token` to `/auth/verify` (so mail scanners can't use the link); its passkey
   button calls `PasskeyClient.signIn()` from `@zeyolabs/kit/auth/sessions/passkeys/client`. A settings page
   uses `AuthLoads.passkeys` and `PasskeyClient.add(name)`, and posts `id` to `/auth/passkey/delete`.

### Accounts and policies

Accounts own resources; users reach them through a membership. Resource tables carry
`account_id`, never `user_id`. Tables: `accounts`, `account_members`, `account_policies`,
`account_invites` (same `schema.ts`).

- **Policies.** Every member has one. Built in: `owner` (everything, can't be edited), `admin`
  (all but `policies.manage`), `member` (the app's `memberPermissions`). An account can add its own
  from permission keys (`resource.action`, or `resource.*`); the app lists its keys in
  `Auth.configure({ accounts: { permissions, memberPermissions } })`. Only owners confer ownership,
  and an account always keeps at least one owner.
- **Which account.** `AccountHandle.create({ slug: AccountHandle.slugFromRoute('account') })` after the auth handle
  sets `locals.account` and `locals.membership` (404 for non-members). Remote functions call
  `AccountHandle.requirePermission(event, 'projects.edit')`, or `Permissions.can(membership, key)`.
- **Invite only.** `isAllowed: (email) => new AccountService(db, catalogue).hasAccess(email)`; invites are emailed links
  to the app's `/invite` page (`AuthLoads.invite`), accepted by posting to `/auth/invite/accept`.
  For the usual admin setup pass `owners: { account: { name, slug }, emails: () => env().ALLOWED_EMAILS }`
  instead: those emails may always sign in and become owners of the account (created on first use, via
  `AccountService.ensureOwner`), and members and invitees may sign in too; `isAllowed` then becomes optional.
  `onSignIn` still runs after it. Removing an email from the list does not revoke someone who has
  already signed in: remove them from the account's members too.
- **Management.** `@zeyolabs/kit/auth/accounts/accounts.remote` has the queries and commands a members page
  needs (members, invites, policies), each checking the caller's permissions.

## Email clients

`IEmailClient` (`deliver` throws, `send` logs and returns `false`) has two transports on
`BaseEmailClient`: `EmailClient` (`cloudflare/email`, a Workers `send_email` binding) and
`SmtpClient` (`cloudflare/email/smtp`, e.g. Amazon SES, any recipient; `SmtpClient.fromEnv(env, sender)`
reads the settings from the request context). `DevEmailClient` prints instead of sending and
`FakeEmailClient` records messages for tests; both work in place of either transport.

## App hooks and Sentry

The setup every app repeats lives here:

```ts
// hooks.client.ts
Sentry.init(SentryConfig.options({ dev, dsn: SENTRY_DSN, updated })); // updated from $app/state
export const handleError = SentryConfig.clientErrors(Sentry.handleErrorWithSentry());

// hooks.server.ts
const sentry = SentryConfig.options({ dev, dsn: SENTRY_DSN, release });
export const handle = sequence(initCloudflareSentryHandle(sentry), sentryHandle(), /* app hooks */, AppHooks.securityHeaders({ private: true }));
export const handleError = AppHooks.serverErrors(Sentry.handleErrorWithSentry(AppHooks.logError));
```

`SentryConfig` (`@zeyolabs/kit/monitoring/sentry`) sends nothing from dev or loopback hosts and
collects no personal data. In the browser, given SvelteKit's `updated`, it doesn't report errors
from a tab left open across a deploy (including failed loads of chunks, stylesheets and routes that
no longer exist): the check for a newer version shows `@zeyolabs/ui`'s `UpdateOverlay` instead
(once in the root layout, `<UpdateOverlay />`). `AppHooks` (`@zeyolabs/kit/server/hooks`) sets
security headers (a `private` app is also never cached or indexed) and reports only unexpected
errors.

## Developing against an app

`pnpm link ../kit` in the app while working on both; publish, then pin the new version.

## Checks

`pnpm check`: prettier, eslint, `tsc` (source, not tests), vitest.
