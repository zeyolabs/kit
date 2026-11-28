import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';

import type { ITurnstileClient } from '../cloudflare/turnstile/client';
import type { AuthDb } from './config';
import type { LoginError } from './login';
import type { Passkeys } from './sessions/passkeys/passkeys';

import { logger } from '../server/logger';
import { Crypto } from '../utils/crypto';
import { Schema } from '../utils/schema';
import { Allowlist } from './allowlist';
import { Auth } from './config';
import { AuthEmails } from './emails';
import { authTokens, passkeys, sessions, users } from './schema';

export type AuthSession = { createdAt: number; expiresAt: number; id: string };
export type AuthUser = { avatarUrl: null | string; email: string; id: number; name: string };

/** What the "email me a sign-in link" form asks for. */
export type EmailLinkRequest = {
	/** The Access identity the visitor already has, if the app sits behind Access. */
	accessEmail: null | string;
	email: unknown;
	hostname: string;
	ip: null | string;
	next: string;
	/** The site's origin, for the link in the email. */
	origin: string;
	/** The Turnstile token the widget put in the form. */
	turnstileToken: string;
};

/**
 * Everything that proves who someone is, in one service: sessions, emailed single-use links,
 * passkey credentials and the users behind them. Framework-agnostic: it takes the db, so a plain
 * Worker (no SvelteKit, no `configureAuth`) can use it too. With a `TurnstileClient`, the
 * email-link form is bot-checked before anything else.
 *
 * Sessions: the cookie is `<id>.<secret>` and only the secret's sha256 is stored. Links: the
 * emailed secret is 256 random bits, only its sha256 is stored, so a leaked row can't be replayed;
 * one is consumed by a single atomic UPDATE, so two clicks (or a mail scanner racing the user)
 * can't both sign in.
 */
export class SignInService {
	/** Session cookie: host-only unless the app sets `cookieDomain`, `secure` always (browsers
	 *  treat localhost as secure). */
	static readonly cookieAttributes = {
		httpOnly: true,
		path: '/',
		sameSite: 'lax',
		secure: true,
	} as const;
	static readonly LINK_TTL_MS = 15 * 60 * 1000;
	/** Unused, unexpired links allowed per email at once: stops someone flooding an inbox. */
	static readonly MAX_LIVE_LINKS = 3;
	/** Session lifetime and sliding renewal: a session used with less than `RENEW_BELOW_MS` left
	 *  is pushed out to a full `SESSION_LIFETIME_MS` again. */
	static readonly SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

	static readonly SESSION_RENEW_BELOW_MS = 15 * 24 * 60 * 60 * 1000;

	constructor(
		private readonly db: AuthDb,
		private readonly turnstile: ITurnstileClient | null = null
	) {}

	static needsRenewal(expiresAt: number, now: number): boolean {
		return expiresAt - now < SignInService.SESSION_RENEW_BELOW_MS;
	}

	/** Checks an email against the allowlist and the Access identity. */
	static async refusal(email: string, accessEmail: null | string): Promise<LoginError | null> {
		if (!(await Auth.config().isAllowed(email))) return 'not_allowed';
		if (accessEmail && !Allowlist.matches(accessEmail, email)) return 'mismatch';
		return null;
	}

	/** Split a `<id>.<secret>` session cookie value. `null` unless it is exactly two parts. */
	static splitToken(token: string): null | { id: string; secret: string } {
		const parts = token.split('.');
		if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
		return { id: parts[0], secret: parts[1] };
	}

	/** Uses a token up and returns its email, or `null` if it is unknown, used or expired. */
	async consumeLink(token: string, now = Date.now()): Promise<null | string> {
		if (!/^[0-9a-f]{64}$/.test(token)) return null;
		const [row] = await this.db
			.update(authTokens)
			.set({ usedAt: now })
			.where(
				and(
					eq(authTokens.tokenHash, Crypto.hashSecret(token)),
					isNull(authTokens.usedAt),
					gt(authTokens.expiresAt, now)
				)
			)
			.returning({ email: authTokens.email });
		return row?.email ?? null;
	}

	/** Inserts a session (hashed secret) and returns the `<id>.<secret>` cookie value. Also clears the
	 *  user's expired rows, so the table doesn't grow forever. */
	async createSession(userId: number, now = Date.now()) {
		const id = Crypto.getRandomSecret(16);
		const secret = Crypto.getRandomSecret(32);
		const expiresAt = now + SignInService.SESSION_LIFETIME_MS;
		await this.db
			.delete(sessions)
			.where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, now)));
		await this.db.insert(sessions).values({
			createdAt: now,
			expiresAt,
			id,
			lastUsedAt: now,
			secretHash: Crypto.hashSecret(secret),
			userId,
		});
		return { expiresAt, id, token: `${id}.${secret}` };
	}

	/** Deletes one of `userId`'s passkeys; `false` if it isn't theirs. */
	async deletePasskey(userId: number, id: string): Promise<boolean> {
		const deleted = await this.db
			.delete(passkeys)
			.where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
			.returning({ id: passkeys.id });
		return deleted.length > 0;
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.db.delete(sessions).where(eq(sessions.id, sessionId));
	}

	async findOrCreateUser(email: string): Promise<AuthUser> {
		const normalized = email.trim().toLowerCase();
		await this.db
			.insert(users)
			.values({ email: normalized, name: normalized.split('@')[0] })
			.onConflictDoNothing({ target: users.email });
		const [user] = await this.db.select().from(users).where(eq(users.email, normalized)).limit(1);
		const { avatarUrl, id, name } = user;
		return { avatarUrl, email: normalized, id, name };
	}

	async findPasskey(id: string) {
		const [row] = await this.db.select().from(passkeys).where(eq(passkeys.id, id)).limit(1);
		return row ?? null;
	}

	/** The user for `email`, created on first sign-in with the email's local part as their name. */
	/** A user by id. */
	async findUser(id: number): Promise<AuthUser> {
		const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
		return user;
	}

	/** A fresh token for `email`, or `null` when it already has `SignInService.MAX_LIVE_LINKS` live ones. */
	async issueLink(email: string, now = Date.now()): Promise<null | string> {
		// Housekeeping first: used or expired rows for this email are never needed again.
		await this.db
			.delete(authTokens)
			.where(
				and(
					eq(authTokens.email, email),
					or(lt(authTokens.expiresAt, now), gt(authTokens.usedAt, 0))
				)
			);
		const live = await this.db
			.select({ tokenHash: authTokens.tokenHash })
			.from(authTokens)
			.where(eq(authTokens.email, email));
		if (live.length >= SignInService.MAX_LIVE_LINKS) return null;

		const token = Crypto.getRandomSecret(32);
		await this.db.insert(authTokens).values({
			createdAt: now,
			email,
			expiresAt: now + SignInService.LINK_TTL_MS,
			tokenHash: Crypto.hashSecret(token),
		});
		return token;
	}

	async listPasskeys(userId: number) {
		return this.db
			.select({
				createdAt: passkeys.createdAt,
				id: passkeys.id,
				lastUsedAt: passkeys.lastUsedAt,
				name: passkeys.name,
			})
			.from(passkeys)
			.where(eq(passkeys.userId, userId))
			.orderBy(passkeys.createdAt);
	}

	async recordPasskeyUse(id: string, signCount: number, now = Date.now()): Promise<void> {
		await this.db.update(passkeys).set({ lastUsedAt: now, signCount }).where(eq(passkeys.id, id));
	}

	/** Pushes a session's expiry out to a full lifetime again; returns the new expiry. */
	async renewSession(sessionId: string, now = Date.now()) {
		const expiresAt = now + SignInService.SESSION_LIFETIME_MS;
		await this.db
			.update(sessions)
			.set({ expiresAt, lastUsedAt: now })
			.where(eq(sessions.id, sessionId));
		return expiresAt;
	}

	/**
	 * The "email me a sign-in link" form: the bot check (when the app has Turnstile on), the allowlist
	 * and Access identity, then a single-use link by email. Unknown emails get the same answer as
	 * known ones, so the form can't probe the allowlist. `error` is why nothing was sent; `sent` is
	 * whether the page should say "check your email".
	 */
	async requestLink(input: EmailLinkRequest): Promise<{ error: LoginError | null; sent: boolean }> {
		if (this.turnstile) {
			const human = await this.turnstile.verify({
				hostname: input.hostname,
				ip: input.ip,
				token: input.turnstileToken,
			});
			if (!human) return { error: 'bot', sent: false };
		}
		const parsed = Schema.Email.safeParse(input.email);
		if (!parsed.success) return { error: 'send', sent: false };
		const email = parsed.data;

		const refused = await SignInService.refusal(email, input.accessEmail);
		if (refused === 'not_allowed') return { error: null, sent: true };
		if (refused) return { error: refused, sent: false };

		const token = await this.issueLink(email);
		if (token) {
			const url = new URL(Auth.config().loginPath, input.origin);
			url.searchParams.set('token', token);
			if (input.next !== '/') url.searchParams.set('next', input.next);
			try {
				const message = {
					email,
					expiresInMinutes: SignInService.LINK_TTL_MS / 60_000,
					url: url.href,
				};
				const { emailBrand, emailFrom } = Auth.config();
				await Auth.config()
					.email()
					.deliver({
						from: emailFrom,
						fromName: emailBrand.name,
						to: email,
						...AuthEmails.magicLink(emailBrand, message),
					});
			} catch (err) {
				logger.error(err, { op: 'auth.magic-link.send' });
				return { error: 'send', sent: false };
			}
		}
		return { error: null, sent: true };
	}

	async savePasskey(
		userId: number,
		name: string,
		credential: ReturnType<typeof Passkeys.verifyRegistration>,
		now = Date.now()
	): Promise<void> {
		await this.db.insert(passkeys).values({ ...credential, createdAt: now, name, userId });
	}

	/** The live session and its user for a cookie value, or `null` if unknown, forged or expired. */
	async validateSession(
		token: string,
		now = Date.now()
	): Promise<null | { session: AuthSession; user: AuthUser }> {
		const split = SignInService.splitToken(token);
		if (!split) return null;
		const [row] = await this.db
			.select({ session: sessions, user: users })
			.from(sessions)
			.innerJoin(users, eq(users.id, sessions.userId))
			.where(eq(sessions.id, split.id))
			.limit(1);
		if (!row || !Crypto.verifySecret(split.secret, row.session.secretHash)) return null;
		if (row.session.expiresAt <= now) return null;
		const { avatarUrl, email, id, name } = row.user;
		const { createdAt, expiresAt } = row.session;
		return {
			session: { createdAt, expiresAt, id: row.session.id },
			user: { avatarUrl, email, id, name },
		};
	}
}
