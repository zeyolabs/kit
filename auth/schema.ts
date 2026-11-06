import { blob, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Auth tables (D1/SQLite). Timestamps are epoch-ms integers. The app includes this file in its
// drizzle-kit `schema` list and generates the migrations; nothing here runs DDL itself.

export const users = sqliteTable('users', {
	avatarUrl: text('avatar_url'),
	createdAt: integer('created_at')
		.notNull()
		.$defaultFn(() => Date.now()),
	/** Always lower-cased: the one identity both sign-in methods resolve to. */
	email: text('email').notNull().unique(),
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
});

/** A signed-in browser. The cookie holds `<id>.<secret>`; only sha256(secret) is stored. */
export const sessions = sqliteTable(
	'sessions',
	{
		createdAt: integer('created_at')
			.notNull()
			.$defaultFn(() => Date.now()),
		expiresAt: integer('expires_at').notNull(),
		id: text('id').primaryKey(),
		lastUsedAt: integer('last_used_at')
			.notNull()
			.$defaultFn(() => Date.now()),
		secretHash: text('secret_hash').notNull(),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id),
	},
	(table) => [index('sessions_user_id_idx').on(table.userId)]
);

/** Magic-link tokens: sha256 of the emailed secret, single use, short-lived. Keyed by email rather
 *  than user, so a first sign-in can create the user only once the link is used. */
export const authTokens = sqliteTable(
	'auth_tokens',
	{
		createdAt: integer('created_at').notNull(),
		email: text('email').notNull(),
		expiresAt: integer('expires_at').notNull(),
		tokenHash: text('token_hash').primaryKey(),
		usedAt: integer('used_at'),
	},
	(table) => [index('auth_tokens_email_idx').on(table.email)]
);

/** WebAuthn credentials. `publicKey` is SEC1 (ES256) or PKCS#1 (RS256), per `algorithm`. */
export const passkeys = sqliteTable(
	'passkeys',
	{
		algorithm: integer('algorithm').notNull(),
		createdAt: integer('created_at').notNull(),
		/** The credential id, base64url without padding. */
		id: text('id').primaryKey(),
		lastUsedAt: integer('last_used_at'),
		name: text('name').notNull(),
		publicKey: blob('public_key', { mode: 'buffer' }).$type<Uint8Array>().notNull(),
		signCount: integer('sign_count').notNull(),
		/** Comma-separated `AuthenticatorTransport` hints from registration. */
		transports: text('transports').notNull().default(''),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
	},
	(table) => [index('passkeys_user_id_idx').on(table.userId)]
);

export type PasskeyRow = typeof passkeys.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type UserRow = typeof users.$inferSelect;
