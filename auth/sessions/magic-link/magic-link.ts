import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';

import type { AuthDb } from '../../config';

import { Crypto } from '../../../utils/crypto';
import { authTokens } from '../../schema';

// Magic-link tokens. The emailed secret is 256 random bits; only its sha256 is stored, so a leaked
// row can't be replayed. A token is consumed by a single atomic UPDATE, so two clicks (or a mail
// scanner racing the user) can't both sign in.

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/** Unused, unexpired links allowed per email at once: stops someone flooding an inbox. */
export const MAX_LIVE_LINKS = 3;

/** A fresh token for `email`, or `null` when it already has `MAX_LIVE_LINKS` live ones. */
export async function issueMagicLinkToken(
	db: AuthDb,
	email: string,
	now = Date.now()
): Promise<null | string> {
	// Housekeeping first: used or expired rows for this email are never needed again.
	await db
		.delete(authTokens)
		.where(
			and(eq(authTokens.email, email), or(lt(authTokens.expiresAt, now), gt(authTokens.usedAt, 0)))
		);
	const live = await db
		.select({ tokenHash: authTokens.tokenHash })
		.from(authTokens)
		.where(eq(authTokens.email, email));
	if (live.length >= MAX_LIVE_LINKS) return null;

	const token = Crypto.getRandomSecret(32);
	await db.insert(authTokens).values({
		createdAt: now,
		email,
		expiresAt: now + MAGIC_LINK_TTL_MS,
		tokenHash: Crypto.hashSecret(token),
	});
	return token;
}

/** Uses a token up and returns its email, or `null` if it is unknown, used or expired. */
export async function consumeMagicLinkToken(
	db: AuthDb,
	token: string,
	now = Date.now()
): Promise<null | string> {
	if (!/^[0-9a-f]{64}$/.test(token)) return null;
	const [row] = await db
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
