import { and, asc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';

import type { AuthDb } from '../config';
import type { PermissionCatalogue, Policy } from './permissions';

import { Error400, Error403, Error404, Error409, ServiceError } from '../../utils/errors';
import { accountInvites, accountMembers, accountPolicies, accounts, users } from '../schema';
import { Permissions } from './permissions';

// Accounts own resources; users reach them through a membership whose policy says what they may
// do. Framework-agnostic: every function takes the db (and the app's permission catalogue), so a
// plain Worker can use it too. Mutations take the acting member and check its permissions; the
// "at least one owner" rule is enforced inside the same SQL statement (D1 has no row locks).

export type AccountSummary = { id: number; name: string; slug: string };
export type Membership = { accountId: number; policy: Policy; userId: number };

const OWNER = 'owner';

function can(membership: Membership | null, permission: string): boolean {
	return !!membership && Permissions.grants(membership.policy.permissions, permission);
}

/** Throws a 403 unless `membership` grants `permission`. */
function assertCan(membership: Membership, permission: string): void {
	if (!can(membership, permission)) throw Error403('You do not have permission to do that');
}

function isValidSlug(slug: string): boolean {
	return /^[a-z0-9][a-z0-9-]{1,39}$/.test(slug);
}

/** Creates an account; with `ownerUserId`, that user becomes its owner. */
async function createAccount(
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

async function findAccountBySlug(db: AuthDb, slug: string): Promise<AccountSummary | null> {
	const [account] = await db
		.select({ id: accounts.id, name: accounts.name, slug: accounts.slug })
		.from(accounts)
		.where(eq(accounts.slug, slug))
		.limit(1);
	return account ?? null;
}

/** The accounts a user belongs to, with their policy key in each, oldest membership first. */
async function listAccountsForUser(db: AuthDb, userId: number) {
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
async function listPolicies(
	db: AuthDb,
	catalogue: PermissionCatalogue,
	accountId: number
): Promise<Policy[]> {
	const custom = await db
		.select()
		.from(accountPolicies)
		.where(eq(accountPolicies.accountId, accountId))
		.orderBy(asc(accountPolicies.name));
	const builtIn = Permissions.builtIns(catalogue);
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

/** A built-in or custom policy of the account by key, or `null`. */
async function findPolicy(
	db: AuthDb,
	catalogue: PermissionCatalogue,
	accountId: number,
	key: string
): Promise<null | Policy> {
	if (Permissions.isBuiltIn(key)) return Permissions.builtIns(catalogue)[key];
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
async function resolveMembership(
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
async function addMember(
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

/**
 * Makes `userId` an owner of the account with this slug, creating the account on first use. Safe to
 * call on every sign-in: an existing account is reused, a user who is already a member keeps their
 * current policy (never promoted or demoted), and two requests creating the same account at once end up with one.
 */
async function ensureOwner(
	db: AuthDb,
	input: { name: string; slug: string },
	userId: number,
	now = Date.now()
): Promise<AccountSummary> {
	let account = await findAccountBySlug(db, input.slug);
	if (!account) {
		try {
			account = await createAccount(db, input, undefined, now);
		} catch (error) {
			// Lost the race: createAccount throws a 409 ('That address is taken') when another
			// request created this slug first, so use theirs.
			if (!(error instanceof ServiceError) || error.status !== 409) throw error;
			account = await findAccountBySlug(db, input.slug);
			if (!account) throw error;
		}
	}
	await addMember(db, account.id, userId, OWNER, now);
	return account;
}

async function listMembers(db: AuthDb, actor: Membership) {
	assertCan(actor, 'members.read');
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
async function setMemberPolicy(
	db: AuthDb,
	catalogue: PermissionCatalogue,
	actor: Membership,
	userId: number,
	policy: string
): Promise<void> {
	assertCan(actor, 'members.manage');
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
async function removeMember(db: AuthDb, actor: Membership, userId: number): Promise<void> {
	if (userId !== actor.userId) assertCan(actor, 'members.manage');
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
async function savePolicy(
	db: AuthDb,
	catalogue: PermissionCatalogue,
	actor: Membership,
	input: { key: string; name: string; permissions: string[] },
	now = Date.now()
): Promise<void> {
	assertCan(actor, 'policies.manage');
	if (!Permissions.isValidKey(input.key))
		throw Error400('Use 1-40 lowercase letters, digits and dashes');
	const bad = input.permissions.filter((p) => !Permissions.isGrantable(catalogue, p));
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
async function deletePolicy(db: AuthDb, actor: Membership, key: string, now = Date.now()) {
	assertCan(actor, 'policies.manage');
	if (Permissions.isBuiltIn(key)) throw Error400('Built-in policies cannot be deleted');
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

/** Whether `email` belongs to any account or holds a live invite: the invite-only sign-in rule. */
async function hasAccountAccess(db: AuthDb, email: string, now = Date.now()) {
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

export const Accounts = {
	addMember,
	assertCan,
	can,
	create: createAccount,
	deletePolicy,
	ensureOwner,
	findBySlug: findAccountBySlug,
	findPolicy,
	hasAccess: hasAccountAccess,
	isValidSlug,
	listForUser: listAccountsForUser,
	listMembers,
	listPolicies,
	removeMember,
	resolveMembership,
	savePolicy,
	setMemberPolicy,
};
