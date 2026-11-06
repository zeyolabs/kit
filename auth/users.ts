import { eq } from 'drizzle-orm';

import type { AuthDb } from './config';
import type { AuthUser } from './sessions/sessions';

import { users } from './schema';

/** Parses a comma-separated allowlist (e.g. an `ALLOWED_EMAILS` var) into lower-cased emails. */
function parseAllowlist(raw: string | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((email) => email.trim().toLowerCase())
		.filter(Boolean);
}

/** Case-insensitive allowlist check. An empty list allows nobody (fail closed). */
function isEmailAllowed(email: string, allowlist: readonly string[] | string | undefined) {
	const list =
		typeof allowlist === 'string' || allowlist === undefined
			? parseAllowlist(allowlist)
			: allowlist.map((e) => e.trim().toLowerCase());
	return list.includes(email.trim().toLowerCase());
}

function emailsMatch(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The user for `email`, created on first sign-in with the email's local part as their name. */
async function findOrCreateUser(db: AuthDb, email: string): Promise<AuthUser> {
	const normalized = email.trim().toLowerCase();
	await db
		.insert(users)
		.values({ email: normalized, name: normalized.split('@')[0] })
		.onConflictDoNothing({ target: users.email });
	const [user] = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
	const { avatarUrl, id, name } = user;
	return { avatarUrl, email: normalized, id, name };
}

export const Allowlist = {
	includes: isEmailAllowed,
	parse: parseAllowlist,
};

export const Users = {
	emailsMatch,
	findOrCreate: findOrCreateUser,
};
