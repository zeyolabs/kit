import { and, asc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';

import type { AuthDb } from '../config';

import { Crypto } from '../../utils/crypto';
import { Error400, Error403, Error404, Error409 } from '../../utils/errors';
import { accountInvites, accountMembers, accountPolicies, accounts, users } from '../schema';
import {
	builtInPolicies,
	grants,
	isBuiltInPolicy,
	isGrantableKey,
	isValidPolicyKey,
	type PermissionCatalogue,
	type Policy,
} from './permissions';

// Accounts own resources; users reach them through a membership whose policy says what they may
// do. Framework-agnostic: every function takes the db (and the app's permission catalogue), so a
// plain Worker can use it too. Mutations take the acting member and check its permissions; the
// "at least one owner" rule is enforced inside the same SQL statement (D1 has no row locks).

export type AccountSummary = { id: number; name: string; slug: string };
export type Membership = { accountId: number; policy: Policy; userId: number };

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const OWNER = 'owner';

export function can(membership: Membership | null, permission: string): boolean {
	return !!membership && grants(membership.policy.permissions, permission);
}

function require(membership: Membership, permission: string): void {
	if (!can(membership, permission)) throw Error403('You do not have permission to do that');
}

export function isValidSlug(slug: string): boolean {
	return /^[a-z0-9][a-z0-9-]{1,39}$/.test(slug);
}

/** Creates an account; with `ownerUserId`, that user becomes its owner. */
export async function createAccount(
	db: AuthDb,
	input: { name: string; slug: string },
	ownerUserId?: number,
	now = Date.now()
): Promise<AccountSummary> {
	if (!isValidSlug(input.slug)) throw Error400('Use 2-40 lowercase letters, digits and dashes');
	const [account] = await db
		.insert(accounts)
		.values({ createdAt: now, name: input.name.trim(), slug: input.slug })
		.onConflictDoNothing({ target: accounts.slug })
		.returning({ id: accounts.id, name: accounts.name, slug: accounts.slug });
	if (!account) throw Error409('That address is taken');
	if (ownerUserId !== undefined) await addMember(db, account.id, ownerUserId, OWNER, now);
	return account;
}

export async function findAccountBySlug(db: AuthDb, slug: string): Promise<AccountSummary | null> {
	const [account] = await db
		.select({ id: accounts.id, name: accounts.name, slug: accounts.slug })
		.from(accounts)
		.where(eq(accounts.slug, slug))
		.limit(1);
	return account ?? null;
}

/** The accounts a user belongs to, with their policy key in each, oldest membership first. */
export async function listAccountsForUser(db: AuthDb, userId: number) {
	return db
		.select({
			id: accounts.id,
			name: accounts.name,
			policy: accountMembers.policy,
			slug: accounts.slug,
		})
		.from(accountMembers)
		.innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
		.where(eq(accountMembers.userId, userId))
		.orderBy(asc(accountMembers.createdAt));
}

/** The built-in policies plus the account's own. */
export async function listPolicies(
	db: AuthDb,
	catalogue: PermissionCatalogue,
	accountId: number
): Promise<Policy[]> {
	const custom = await db
		.select()
		.from(accountPolicies)
		.where(eq(accountPolicies.accountId, accountId))
		.orderBy(asc(accountPolicies.name));
	const builtIn = builtInPolicies(catalogue);
	return [
		builtIn.owner,
		builtIn.admin,
		builtIn.member,
		...custom.map((p) => ({
			builtIn: false,
			key: p.key,
			name: p.name,
			permissions: p.permissions,
		})),
	];
}

async function findPolicy(
	db: AuthDb,
	catalogue: PermissionCatalogue,
	accountId: number,
	key: string
): Promise<null | Policy> {
	if (isBuiltInPolicy(key)) return builtInPolicies(catalogue)[key];
	const [row] = await db
		.select()
		.from(accountPolicies)
		.where(and(eq(accountPolicies.accountId, accountId), eq(accountPolicies.key, key)))
		.limit(1);
	return row
		? { builtIn: false, key: row.key, name: row.name, permissions: row.permissions }
		: null;
}

/** The user's membership of the account with its resolved policy, or `null` if not a member. */
export async function resolveMembership(
	db: AuthDb,
	catalogue: PermissionCatalogue,
	accountId: number,
	userId: number
): Promise<Membership | null> {
	const [row] = await db
		.select({ policy: accountMembers.policy })
		.from(accountMembers)
		.where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
		.limit(1);
	if (!row) return null;
	// A member whose custom policy was somehow removed keeps no permissions rather than failing.
	const policy = (await findPolicy(db, catalogue, accountId, row.policy)) ?? {
		builtIn: false,
		key: row.policy,
		name: row.policy,
		permissions: [],
	};
	return { accountId, policy, userId };
}

/** Adds a member (no-op if already one). For bootstrapping and invites; no permission check. */
export async function addMember(
	db: AuthDb,
	accountId: number,
	userId: number,
	policy: string,
	now = Date.now()
): Promise<void> {
	await db
		.insert(accountMembers)
		.values({ accountId, createdAt: now, policy, userId })
		.onConflictDoNothing();
}

export async function listMembers(db: AuthDb, actor: Membership) {
	require(actor, 'members.read');
	return db
		.select({
			email: users.email,
			joinedAt: accountMembers.createdAt,
			name: users.name,
			policy: accountMembers.policy,
			userId: users.id,
		})
		.from(accountMembers)
		.innerJoin(users, eq(users.id, accountMembers.userId))
		.where(eq(accountMembers.accountId, actor.accountId))
		.orderBy(asc(users.email));
}

/** SQL: another owner of the account remains besides `userId`. */
const anotherOwner = (accountId: number, userId: number) =>
	sql`exists (select 1 from ${accountMembers} where ${accountMembers.accountId} = ${accountId} and ${accountMembers.policy} = ${OWNER} and ${accountMembers.userId} != ${userId})`;

async function currentPolicy(db: AuthDb, accountId: number, userId: number) {
	const [row] = await db
		.select({ policy: accountMembers.policy })
		.from(accountMembers)
		.where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
		.limit(1);
	if (!row) throw Error404('Not a member of this account');
	return row.policy;
}

/** Gives a member another policy. Only owners confer or take away ownership; nobody changes their
 *  own policy; the last owner stays an owner. */
export async function setMemberPolicy(
	db: AuthDb,
	catalogue: PermissionCatalogue,
	actor: Membership,
	userId: number,
	policy: string
): Promise<void> {
	require(actor, 'members.manage');
	if (userId === actor.userId) throw Error400('You cannot change your own policy');
	if (!(await findPolicy(db, catalogue, actor.accountId, policy))) throw Error400('Unknown policy');
	const previous = await currentPolicy(db, actor.accountId, userId);
	if ((policy === OWNER || previous === OWNER) && actor.policy.key !== OWNER) {
		throw Error403('Only an owner can change ownership');
	}
	const updated = await db
		.update(accountMembers)
		.set({ policy })
		.where(
			and(
				eq(accountMembers.accountId, actor.accountId),
				eq(accountMembers.userId, userId),
				or(ne(accountMembers.policy, OWNER), anotherOwner(actor.accountId, userId))
			)
		)
		.returning({ userId: accountMembers.userId });
	if (!updated.length) throw Error409('An account needs at least one owner');
}

/** Removes a member, or lets a member leave. Only owners remove owners; the last owner can't go. */
export async function removeMember(db: AuthDb, actor: Membership, userId: number): Promise<void> {
	if (userId !== actor.userId) require(actor, 'members.manage');
	const previous = await currentPolicy(db, actor.accountId, userId);
	if (previous === OWNER && userId !== actor.userId && actor.policy.key !== OWNER) {
		throw Error403('Only an owner can remove an owner');
	}
	const removed = await db
		.delete(accountMembers)
		.where(
			and(
				eq(accountMembers.accountId, actor.accountId),
				eq(accountMembers.userId, userId),
				or(ne(accountMembers.policy, OWNER), anotherOwner(actor.accountId, userId))
			)
		)
		.returning({ userId: accountMembers.userId });
	if (!removed.length) throw Error409('An account needs at least one owner');
}

/** Creates or updates one of the account's own policies. */
export async function savePolicy(
	db: AuthDb,
	catalogue: PermissionCatalogue,
	actor: Membership,
	input: { key: string; name: string; permissions: string[] },
	now = Date.now()
): Promise<void> {
	require(actor, 'policies.manage');
	if (!isValidPolicyKey(input.key)) throw Error400('Use 1-40 lowercase letters, digits and dashes');
	const bad = input.permissions.filter((p) => !isGrantableKey(catalogue, p));
	if (bad.length) throw Error400(`Unknown permissions: ${bad.join(', ')}`);
	const permissions = [...new Set(input.permissions)].sort();
	await db
		.insert(accountPolicies)
		.values({
			accountId: actor.accountId,
			createdAt: now,
			key: input.key,
			name: input.name.trim(),
			permissions,
		})
		.onConflictDoUpdate({
			set: { name: input.name.trim(), permissions },
			target: [accountPolicies.accountId, accountPolicies.key],
		});
}

/** Deletes one of the account's own policies, unless a member or a pending invite still uses it. */
export async function deletePolicy(db: AuthDb, actor: Membership, key: string, now = Date.now()) {
	require(actor, 'policies.manage');
	if (isBuiltInPolicy(key)) throw Error400('Built-in policies cannot be deleted');
	const [used] = await db
		.select({ userId: accountMembers.userId })
		.from(accountMembers)
		.where(and(eq(accountMembers.accountId, actor.accountId), eq(accountMembers.policy, key)))
		.limit(1);
	const [invited] = await db
		.select({ email: accountInvites.email })
		.from(accountInvites)
		.where(
			and(
				eq(accountInvites.accountId, actor.accountId),
				eq(accountInvites.policy, key),
				isNull(accountInvites.acceptedAt),
				gt(accountInvites.expiresAt, now)
			)
		)
		.limit(1);
	if (used || invited) throw Error409('Move its members and invites to another policy first');
	await db
		.delete(accountPolicies)
		.where(and(eq(accountPolicies.accountId, actor.accountId), eq(accountPolicies.key, key)));
}

/** Invites `email` with `policy`; replaces any earlier pending invite for that email. Returns the
 *  token for the emailed link. */
export async function createInvite(
	db: AuthDb,
	catalogue: PermissionCatalogue,
	actor: Membership,
	input: { email: string; policy: string },
	now = Date.now()
): Promise<string> {
	require(actor, 'members.invite');
	const email = input.email.trim().toLowerCase();
	if (input.policy === OWNER && actor.policy.key !== OWNER) {
		throw Error403('Only an owner can invite an owner');
	}
	if (!(await findPolicy(db, catalogue, actor.accountId, input.policy))) {
		throw Error400('Unknown policy');
	}
	const [member] = await db
		.select({ userId: accountMembers.userId })
		.from(accountMembers)
		.innerJoin(users, eq(users.id, accountMembers.userId))
		.where(and(eq(accountMembers.accountId, actor.accountId), eq(users.email, email)))
		.limit(1);
	if (member) throw Error409('Already a member');

	await db
		.delete(accountInvites)
		.where(
			and(
				eq(accountInvites.accountId, actor.accountId),
				eq(accountInvites.email, email),
				isNull(accountInvites.acceptedAt)
			)
		);
	const token = Crypto.getRandomSecret(32);
	await db.insert(accountInvites).values({
		accountId: actor.accountId,
		createdAt: now,
		email,
		expiresAt: now + INVITE_TTL_MS,
		invitedBy: actor.userId,
		policy: input.policy,
		tokenHash: Crypto.hashSecret(token),
	});
	return token;
}

export async function listInvites(db: AuthDb, actor: Membership, now = Date.now()) {
	require(actor, 'members.read');
	return db
		.select({
			email: accountInvites.email,
			expiresAt: accountInvites.expiresAt,
			policy: accountInvites.policy,
		})
		.from(accountInvites)
		.where(
			and(
				eq(accountInvites.accountId, actor.accountId),
				isNull(accountInvites.acceptedAt),
				gt(accountInvites.expiresAt, now)
			)
		)
		.orderBy(asc(accountInvites.email));
}

export async function revokeInvite(db: AuthDb, actor: Membership, email: string): Promise<void> {
	require(actor, 'members.invite');
	await db
		.delete(accountInvites)
		.where(
			and(
				eq(accountInvites.accountId, actor.accountId),
				eq(accountInvites.email, email.trim().toLowerCase()),
				isNull(accountInvites.acceptedAt)
			)
		);
}

/** A live (pending, unexpired) invite and its account, for the invite page. */
export async function findInvite(db: AuthDb, token: string, now = Date.now()) {
	if (!/^[0-9a-f]{64}$/.test(token)) return null;
	const [row] = await db
		.select({ account: accounts, email: accountInvites.email, policy: accountInvites.policy })
		.from(accountInvites)
		.innerJoin(accounts, eq(accounts.id, accountInvites.accountId))
		.where(
			and(
				eq(accountInvites.tokenHash, Crypto.hashSecret(token)),
				isNull(accountInvites.acceptedAt),
				gt(accountInvites.expiresAt, now)
			)
		)
		.limit(1);
	if (!row) return null;
	const { id, name, slug } = row.account;
	return { account: { id, name, slug }, email: row.email, policy: row.policy };
}

/** Accepts an invite for the signed-in `user`, whose email must be the invited one. Single use. */
export async function acceptInvite(
	db: AuthDb,
	token: string,
	user: { email: string; id: number },
	now = Date.now()
): Promise<AccountSummary> {
	const invite = await findInvite(db, token, now);
	if (!invite) throw Error404('This invite has expired or was already used');
	if (invite.email !== user.email.toLowerCase()) {
		throw Error403(`This invite is for ${invite.email}. Sign in with that email to accept it.`);
	}
	const [used] = await db
		.update(accountInvites)
		.set({ acceptedAt: now })
		.where(
			and(eq(accountInvites.tokenHash, Crypto.hashSecret(token)), isNull(accountInvites.acceptedAt))
		)
		.returning({ policy: accountInvites.policy });
	if (!used) throw Error404('This invite has expired or was already used');
	await addMember(db, invite.account.id, user.id, used.policy, now);
	return invite.account;
}

/** Whether `email` belongs to any account or holds a live invite: the invite-only sign-in rule. */
export async function hasAccountAccess(db: AuthDb, email: string, now = Date.now()) {
	const normalized = email.trim().toLowerCase();
	const [member] = await db
		.select({ userId: accountMembers.userId })
		.from(accountMembers)
		.innerJoin(users, eq(users.id, accountMembers.userId))
		.where(eq(users.email, normalized))
		.limit(1);
	if (member) return true;
	const [invite] = await db
		.select({ email: accountInvites.email })
		.from(accountInvites)
		.where(
			and(
				eq(accountInvites.email, normalized),
				isNull(accountInvites.acceptedAt),
				gt(accountInvites.expiresAt, now)
			)
		)
		.limit(1);
	return !!invite;
}
