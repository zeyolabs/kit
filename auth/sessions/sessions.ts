import { and, eq, lt } from 'drizzle-orm';

import type { AuthDb } from '../config';

import { Crypto } from '../../utils/crypto';
import { SESSION_LIFETIME_MS, SESSION_RENEW_BELOW_MS } from '../config';
import { sessions, users } from '../schema';

// Framework-agnostic session store: every function takes the db, so a plain Worker (no SvelteKit,
// no `configureAuth`) can use it too.

export type AuthSession = { createdAt: number; expiresAt: number; id: string };
export type AuthUser = { avatarUrl: null | string; email: string; id: number; name: string };

/** Split a `<id>.<secret>` session cookie value. `null` unless it is exactly two parts. */
export function splitSessionToken(token: string): null | { id: string; secret: string } {
	const parts = token.split('.');
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return { id: parts[0], secret: parts[1] };
}

export function needsRenewal(expiresAt: number, now: number): boolean {
	return expiresAt - now < SESSION_RENEW_BELOW_MS;
}

/** Inserts a session (hashed secret) and returns the `<id>.<secret>` cookie value. Also clears the
 *  user's expired rows, so the table doesn't grow forever. */
export async function createSession(db: AuthDb, userId: number, now = Date.now()) {
	const id = Crypto.getRandomSecret(16);
	const secret = Crypto.getRandomSecret(32);
	const expiresAt = now + SESSION_LIFETIME_MS;
	await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, now)));
	await db.insert(sessions).values({
		createdAt: now,
		expiresAt,
		id,
		lastUsedAt: now,
		secretHash: Crypto.hashSecret(secret),
		userId,
	});
	return { expiresAt, id, token: `${id}.${secret}` };
}

/** The live session and its user for a cookie value, or `null` if unknown, forged or expired. */
export async function validateSession(
	db: AuthDb,
	token: string,
	now = Date.now()
): Promise<null | { session: AuthSession; user: AuthUser }> {
	const split = splitSessionToken(token);
	if (!split) return null;
	const [row] = await db
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

/** Pushes a session's expiry out to a full lifetime again; returns the new expiry. */
export async function renewSession(db: AuthDb, sessionId: string, now = Date.now()) {
	const expiresAt = now + SESSION_LIFETIME_MS;
	await db.update(sessions).set({ expiresAt, lastUsedAt: now }).where(eq(sessions.id, sessionId));
	return expiresAt;
}

export async function deleteSession(db: AuthDb, sessionId: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, sessionId));
}
