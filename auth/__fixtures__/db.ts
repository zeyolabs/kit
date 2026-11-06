import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

import type { AuthDb } from '../config';

// An in-memory SQLite with the auth tables, async like D1. Mirrors `schema.ts`.
const DDL = [
	`CREATE TABLE users (id integer PRIMARY KEY AUTOINCREMENT, email text NOT NULL UNIQUE, name text NOT NULL, avatar_url text, created_at integer NOT NULL)`,
	`CREATE TABLE sessions (id text PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id), secret_hash text NOT NULL, expires_at integer NOT NULL, created_at integer NOT NULL, last_used_at integer NOT NULL)`,
	`CREATE TABLE auth_tokens (token_hash text PRIMARY KEY, email text NOT NULL, expires_at integer NOT NULL, used_at integer, created_at integer NOT NULL)`,
	`CREATE TABLE passkeys (id text PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, name text NOT NULL, public_key blob NOT NULL, algorithm integer NOT NULL, sign_count integer NOT NULL, transports text NOT NULL DEFAULT '', created_at integer NOT NULL, last_used_at integer)`,
	`CREATE TABLE accounts (id integer PRIMARY KEY AUTOINCREMENT, slug text NOT NULL UNIQUE, name text NOT NULL, created_at integer NOT NULL)`,
	`CREATE TABLE account_members (account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, policy text NOT NULL, created_at integer NOT NULL, PRIMARY KEY (account_id, user_id))`,
	`CREATE TABLE account_policies (id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, key text NOT NULL, name text NOT NULL, permissions text NOT NULL, created_at integer NOT NULL)`,
	`CREATE UNIQUE INDEX account_policies_account_key_idx ON account_policies (account_id, key)`,
	`CREATE TABLE account_invites (token_hash text PRIMARY KEY, account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, email text NOT NULL, policy text NOT NULL, invited_by integer REFERENCES users(id) ON DELETE SET NULL, expires_at integer NOT NULL, accepted_at integer, created_at integer NOT NULL)`,
];

export async function createTestDb(): Promise<AuthDb> {
	const client = createClient({ url: ':memory:' });
	for (const statement of DDL) await client.execute(statement);
	return drizzle(client) as unknown as AuthDb;
}
