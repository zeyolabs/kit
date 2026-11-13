import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type { IEmailClient } from '../cloudflare/email/base';
import type { EmailBrand } from '../utils/email';
import type { PermissionCatalogue } from './accounts/permissions';
import type { AuthUser } from './sessions/sessions';

import { Accounts } from './accounts/accounts';
import { Allowlist } from './users';

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
	/** Share the session cookie with every subdomain of this domain (e.g. `example.com` for
	 *  `app.example.com` and `mcp.example.com`), so one sign-in covers them all. Every subdomain's
	 *  server then receives the cookie, so only set it when you control all of them. Default:
	 *  host-only. Changing it signs everyone out once (the old cookie no longer matches). */
	cookieDomain?: string;
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
	isAllowed?: (email: string) => boolean | Promise<boolean>;
	/** Runs after each sign-in, after the `owners` step if that is set. */
	onSignIn?: (user: AuthUser) => Promise<void>;
	/**
	 * Invite-only bootstrap, the usual admin setup: the emails in `emails` (a comma-separated
	 * allowlist var, read per call) may always sign in and become owners of `account` on their first
	 * sign-in (the account is created if it doesn't exist). Anyone else may sign in if they are a
	 * member of an account or invited to one. With this set, `isAllowed` is optional and, if given,
	 * is checked in addition (an email passes if either allows it).
	 *
	 * Removing an email from `emails` does not sign out someone who already signed in: their owner
	 * membership stays and `Accounts.hasAccess` keeps allowing them. Remove them from the account's
	 * members too (the members page) to revoke access.
	 */
	owners?: {
		account: { name: string; slug: string };
		emails: () => string | undefined;
	};
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
	/** Always set: the app's `isAllowed`, or the one built from `owners`. */
	isAllowed: (email: string) => boolean | Promise<boolean>;
	loginPath: string;
};

let current: null | ResolvedAuthConfig = null;

/** Registers the app's auth config. Call once at module scope (e.g. next to `secretNames`), so
 *  importing the hooks file registers it. */
function configureAuth(
	config: AuthConfig & Partial<Omit<ResolvedAuthConfig, keyof AuthConfig>>
): void {
	const { isAllowed, onSignIn, owners } = config;
	if (!isAllowed && !owners) {
		throw new Error('configureAuth() needs isAllowed or owners');
	}
	const db = config.db;
	const isOwnerEmail = (email: string) => !!owners && Allowlist.includes(email, owners.emails());
	current = {
		accountHome: (slug) => `/${slug}`,
		cookieName: 'session',
		invitePath: '/invite',
		loginPath: '/login',
		...config,
		isAllowed: owners
			? async (email) =>
					isOwnerEmail(email) ||
					(await Accounts.hasAccess(db(), email)) ||
					(isAllowed ? await isAllowed(email) : false)
			: isAllowed!,
		onSignIn: owners
			? async (user) => {
					if (isOwnerEmail(user.email)) {
						await Accounts.ensureOwner(db(), owners.account, user.id);
					}
					await onSignIn?.(user);
				}
			: onSignIn,
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
