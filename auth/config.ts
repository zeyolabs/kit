import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type { IEmailClient } from '../cloudflare/email/base';
import type { EmailBrand } from '../utils/email';
import type { PermissionCatalogue } from './accounts/permissions';
import type { AuthUser } from './sessions/sessions';

/** Any async drizzle SQLite client (D1 in prod). A consumer's larger, schema-bound `Db` is
 *  assignable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AuthDb = BaseSQLiteDatabase<'async', any, any>;

export type MagicLinkMessage = {
	/** The email the link was requested for (already lower-cased). */
	email: string;
	expiresInMinutes: number;
	url: string;
};

export type AuthConfig = {
	/** The app's permission keys and what plain members get (see `accounts/permissions.ts`). */
	accounts: PermissionCatalogue;
	/** Shown by the browser's passkey prompt and in the magic-link email. */
	appName: string;
	db: () => AuthDb;
	/** Sends the sign-in email (`magicLinkEmail`): any `IEmailClient`, e.g. `SmtpClient`, or
	 *  `DevEmailClient` locally (it prints the link). Called per request. */
	email: () => IEmailClient;
	/** Name and colours for the sign-in email. */
	emailBrand: EmailBrand;
	/** Who may sign in at all. Checked when a link is requested, when it is used, and on every
	 *  request, so removing someone signs them out. Unknown emails get the same "check your email"
	 *  answer as known ones but no email. Invite-only apps use `hasAccountAccess` (a member of
	 *  some account, or invited to one). */
	isAllowed: (email: string) => boolean | Promise<boolean>;
	/** Runs after each sign-in, e.g. to make bootstrap emails owners of the app's account. */
	onSignIn?: (user: AuthUser) => Promise<void>;
	/** The passkey domain (WebAuthn RP id). Default: the request's hostname. Set a parent domain
	 *  (e.g. `example.com` for `app.example.com`) to share passkeys across its subdomains; it can't
	 *  change later without orphaning every passkey. */
	passkeyRpId?: string;
};

export type ResolvedAuthConfig = AuthConfig & {
	/** Where an accepted invite lands. Default: `/<slug>`. */
	accountHome: (slug: string) => string;
	cookieName: string;
	/** The page that shows an invite (`inviteLoad`). Default: `/invite`. */
	invitePath: string;
	loginPath: string;
};

let current: null | ResolvedAuthConfig = null;

/** Registers the app's auth config. Call once at module scope (e.g. next to `secretNames`), so
 *  importing the hooks file registers it. */
function configureAuth(
	config: AuthConfig & Partial<Omit<ResolvedAuthConfig, keyof AuthConfig>>
): void {
	current = {
		accountHome: (slug) => `/${slug}`,
		cookieName: 'session',
		invitePath: '/invite',
		loginPath: '/login',
		...config,
	};
}

function auth(): ResolvedAuthConfig {
	if (!current) throw new Error('configureAuth() has not been called');
	return current;
}

export const Auth = {
	config: auth,
	configure: configureAuth,
};
