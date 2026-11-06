import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

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
	/** Shown by the browser's passkey prompt and in the magic-link email. */
	appName: string;
	db: () => AuthDb;
	/** Who may sign in at all. Checked when a link is requested, when it is used, and on every
	 *  request, so removing someone signs them out. Unknown emails get the same "check your email"
	 *  answer as known ones but no email. */
	isAllowed: (email: string) => boolean;
	/** Delivers the link; see `magicLinkEmail` for a ready-made message. */
	sendMagicLink: (message: MagicLinkMessage) => Promise<void>;
};

export type ResolvedAuthConfig = AuthConfig & {
	cookieName: string;
	loginPath: string;
};

let current: null | ResolvedAuthConfig = null;

/** Registers the app's auth config. Call once at module scope (e.g. next to `secretNames`), so
 *  importing the hooks file registers it. */
export function configureAuth(
	config: AuthConfig & { cookieName?: string; loginPath?: string }
): void {
	current = { cookieName: 'session', loginPath: '/login', ...config };
}

export function auth(): ResolvedAuthConfig {
	if (!current) throw new Error('configureAuth() has not been called');
	return current;
}

/** Session lifetime and sliding renewal: a session used with less than `RENEW_BELOW_MS` left is
 *  pushed out to a full `SESSION_LIFETIME_MS` again. */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_RENEW_BELOW_MS = 15 * 24 * 60 * 60 * 1000;

/** Adding a passkey needs a session signed in this recently, so a stolen session cookie can't
 *  quietly plant a lasting credential. */
export const FRESH_SESSION_MS = 15 * 60 * 1000;

/** Session cookie: host-only (no `domain`), `secure` always (browsers treat localhost as secure). */
export const sessionCookieAttributes = {
	httpOnly: true,
	path: '/',
	sameSite: 'lax',
	secure: true,
} as const;
