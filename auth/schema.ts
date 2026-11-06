import {
	blob,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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

/** What owns resources. Users sign in; accounts own things, and users reach them by membership.
 *  Resource tables carry `account_id`, never `user_id`. */
export const accounts = sqliteTable('accounts', {
	createdAt: integer('created_at').notNull(),
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	/** URL id, `[a-z0-9-]`, unique. */
	slug: text('slug').notNull().unique(),
});

/** A user's membership of an account. `policy` is a built-in policy key (`owner`, `admin`,
 *  `member`) or the key of one of the account's custom `account_policies`. */
export const accountMembers = sqliteTable(
	'account_members',
	{
		accountId: integer('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		createdAt: integer('created_at').notNull(),
		policy: text('policy').notNull(),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
	},
	(table) => [
		primaryKey({ columns: [table.accountId, table.userId] }),
		index('account_members_user_id_idx').on(table.userId),
	]
);

/** An account's own policies: a named set of permission keys, on top of the built-in ones. */
export const accountPolicies = sqliteTable(
	'account_policies',
	{
		accountId: integer('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		createdAt: integer('created_at').notNull(),
		id: integer('id').primaryKey({ autoIncrement: true }),
		/** `[a-z0-9-]`, unique per account, never a built-in key. */
		key: text('key').notNull(),
		name: text('name').notNull(),
		permissions: text('permissions', { mode: 'json' }).$type<string[]>().notNull(),
	},
	(table) => [uniqueIndex('account_policies_account_key_idx').on(table.accountId, table.key)]
);

/** An emailed invitation to join an account with a policy. Only sha256(token) is stored; it is
 *  single use and can only be accepted by a session for the invited email. */
export const accountInvites = sqliteTable(
	'account_invites',
	{
		acceptedAt: integer('accepted_at'),
		accountId: integer('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		createdAt: integer('created_at').notNull(),
		email: text('email').notNull(),
		expiresAt: integer('expires_at').notNull(),
		invitedBy: integer('invited_by').references(() => users.id, { onDelete: 'set null' }),
		policy: text('policy').notNull(),
		tokenHash: text('token_hash').primaryKey(),
	},
	(table) => [
		index('account_invites_account_id_idx').on(table.accountId),
		index('account_invites_email_idx').on(table.email),
	]
);

export type AccountRow = typeof accounts.$inferSelect;
export type PasskeyRow = typeof passkeys.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type UserRow = typeof users.$inferSelect;
