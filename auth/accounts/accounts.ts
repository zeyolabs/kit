import { and, asc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';

import type { AuthDb } from '../config';
import type { PermissionCatalogue, Policy } from './permissions';

import { Crypto } from '../../utils/crypto';
import { Error400, Error403, Error404, Error409, ServiceError } from '../../utils/errors';
import { accountInvites, accountMembers, accountPolicies, accounts, users } from '../schema';
import { Permissions } from './permissions';

export type AccountSummary = { id: number; name: string; slug: string };
export type Membership = { accountId: number; policy: Policy; userId: number };

const OWNER = 'owner';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** SQL: another owner of the account remains besides `userId`. */
const anotherOwner = (accountId: number, userId: number) =>
	sql`exists (select 1 from ${accountMembers} where ${accountMembers.accountId} = ${accountId} and ${accountMembers.policy} = ${OWNER} and ${accountMembers.userId} != ${userId})`;

/**
 * Accounts own resources; users reach them through a membership whose policy says what they may do.
 * One service for the account, its members, its policies and its invitations. Framework-agnostic: it
 * takes the db and the app's permission catalogue, so a plain Worker can use it too. Mutations take
 * the acting member and check its permissions; the "at least one owner" rule is enforced inside the
 * same SQL statement (D1 has no row locks). Invites are emailed single-use links, accepted only by a
 * session for the invited email.
 */
export class AccountService {
	static readonly INVITE_TTL_MS = INVITE_TTL_MS;

	constructor(
		private readonly db: AuthDb,
		private readonly catalogue: PermissionCatalogue
	) {}

	static isValidSlug(slug: string): boolean {
		return /^[a-z0-9][a-z0-9-]{1,39}$/.test(slug);
	}

	/** Accepts an invite for the signed-in `user`, whose email must be the invited one. Single use. */
	async acceptInvite(
		token: string,
		user: { email: string; id: number },
		now = Date.now()
	): Promise<AccountSummary> {
		const invite = await this.findInvite(token, now);
		if (!invite) throw Error404('This invite has expired or was already used');
		if (invite.email !== user.email.toLowerCase()) {
			throw Error403(`This invite is for ${invite.email}. Sign in with that email to accept it.`);
		}
		const [used] = await this.db
			.update(accountInvites)
			.set({ acceptedAt: now })
			.where(
				and(
					eq(accountInvites.tokenHash, Crypto.hashSecret(token)),
					isNull(accountInvites.acceptedAt)
				)
			)
			.returning({ policy: accountInvites.policy });
		if (!used) throw Error404('This invite has expired or was already used');
		await this.addMember(invite.account.id, user.id, used.policy, now);
		return invite.account;
	}

	/** Adds a member (no-op if already one). For bootstrapping and invites; no permission check. */
	async addMember(
		accountId: number,
		userId: number,
		policy: string,
		now = Date.now()
	): Promise<void> {
		await this.db
			.insert(accountMembers)
			.values({ accountId, createdAt: now, policy, userId })
			.onConflictDoNothing();
	}

	/** Creates an account; with `ownerUserId`, that user becomes its owner. */
	async create(
		input: { name: string; slug: string },
		ownerUserId?: number,
		now = Date.now()
	): Promise<AccountSummary> {
		if (!AccountService.isValidSlug(input.slug))
			throw Error400('Use 2-40 lowercase letters, digits and dashes');
		const [account] = await this.db
			.insert(accounts)
			.values({ createdAt: now, name: input.name.trim(), slug: input.slug })
			.onConflictDoNothing({ target: accounts.slug })
			.returning({ id: accounts.id, name: accounts.name, slug: accounts.slug });
		if (!account) throw Error409('That address is taken');
		if (ownerUserId !== undefined) await this.addMember(account.id, ownerUserId, OWNER, now);
		return account;
	}

	/** Invites `email` with `policy`; replaces any earlier pending invite for that email. Returns the
	 *  token for the emailed link. */
	async createInvite(
		actor: Membership,
		input: { email: string; policy: string },
		now = Date.now()
	): Promise<string> {
		Permissions.assertCan(actor, 'members.invite');
		const email = input.email.trim().toLowerCase();
		if (input.policy === OWNER && actor.policy.key !== OWNER) {
			throw Error403('Only an owner can invite an owner');
		}
		if (!(await this.findPolicy(actor.accountId, input.policy))) {
			throw Error400('Unknown policy');
		}
		const [member] = await this.db
			.select({ userId: accountMembers.userId })
			.from(accountMembers)
			.innerJoin(users, eq(users.id, accountMembers.userId))
			.where(and(eq(accountMembers.accountId, actor.accountId), eq(users.email, email)))
			.limit(1);
		if (member) throw Error409('Already a member');

		await this.db
			.delete(accountInvites)
			.where(
				and(
					eq(accountInvites.accountId, actor.accountId),
					eq(accountInvites.email, email),
					isNull(accountInvites.acceptedAt)
				)
			);
		const token = Crypto.getRandomSecret(32);
		await this.db.insert(accountInvites).values({
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

	async currentPolicy(accountId: number, userId: number) {
		const [row] = await this.db
			.select({ policy: accountMembers.policy })
			.from(accountMembers)
			.where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
			.limit(1);
		if (!row) throw Error404('Not a member of this account');
		return row.policy;
	}

	/** Deletes one of the account's own policies, unless a member or a pending invite still uses it. */
	async deletePolicy(actor: Membership, key: string, now = Date.now()) {
		Permissions.assertCan(actor, 'policies.manage');
		if (Permissions.isBuiltIn(key)) throw Error400('Built-in policies cannot be deleted');
		const [used] = await this.db
			.select({ userId: accountMembers.userId })
			.from(accountMembers)
			.where(and(eq(accountMembers.accountId, actor.accountId), eq(accountMembers.policy, key)))
			.limit(1);
		const [invited] = await this.db
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
		await this.db
			.delete(accountPolicies)
			.where(and(eq(accountPolicies.accountId, actor.accountId), eq(accountPolicies.key, key)));
	}

	/**
	 * Makes `userId` an owner of the account with this slug, creating the account on first use. Safe to
	 * call on every sign-in: an existing account is reused, a user who is already a member keeps their
	 * current policy (never promoted or demoted), and two requests creating the same account at once end up with one.
	 */
	async ensureOwner(
		input: { name: string; slug: string },
		userId: number,
		now = Date.now()
	): Promise<AccountSummary> {
		let account = await this.findBySlug(input.slug);
		if (!account) {
			try {
				account = await this.create(input, undefined, now);
			} catch (error) {
				// Lost the race: createAccount throws a 409 ('That address is taken') when another
				// request created this slug first, so use theirs.
				if (!(error instanceof ServiceError) || error.status !== 409) throw error;
				account = await this.findBySlug(input.slug);
				if (!account) throw error;
			}
		}
		await this.addMember(account.id, userId, OWNER, now);
		return account;
	}

	async findBySlug(slug: string): Promise<AccountSummary | null> {
		const [account] = await this.db
			.select({ id: accounts.id, name: accounts.name, slug: accounts.slug })
			.from(accounts)
			.where(eq(accounts.slug, slug))
			.limit(1);
		return account ?? null;
	}

	/** A live (pending, unexpired) invite and its account, for the invite page. */
	async findInvite(token: string, now = Date.now()) {
		if (!/^[0-9a-f]{64}$/.test(token)) return null;
		const [row] = await this.db
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

	/** A built-in or custom policy of the account by key, or `null`. */
	async findPolicy(accountId: number, key: string): Promise<null | Policy> {
		if (Permissions.isBuiltIn(key)) return Permissions.builtIns(this.catalogue)[key];
		const [row] = await this.db
			.select()
			.from(accountPolicies)
			.where(and(eq(accountPolicies.accountId, accountId), eq(accountPolicies.key, key)))
			.limit(1);
		return row
			? { builtIn: false, key: row.key, name: row.name, permissions: row.permissions }
			: null;
	}

	/** Whether `email` belongs to any account or holds a live invite: the invite-only sign-in rule. */
	async hasAccess(email: string, now = Date.now()) {
		const normalized = email.trim().toLowerCase();
		const [member] = await this.db
			.select({ userId: accountMembers.userId })
			.from(accountMembers)
			.innerJoin(users, eq(users.id, accountMembers.userId))
			.where(eq(users.email, normalized))
			.limit(1);
		if (member) return true;
		const [invite] = await this.db
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

	/** The accounts a user belongs to, with their policy key in each, oldest membership first. */
	async listForUser(userId: number) {
		return this.db
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

	async listInvites(actor: Membership, now = Date.now()) {
		Permissions.assertCan(actor, 'members.read');
		return this.db
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

	async listMembers(actor: Membership) {
		Permissions.assertCan(actor, 'members.read');
		return this.db
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

	/** The built-in policies plus the account's own. */
	async listPolicies(accountId: number): Promise<Policy[]> {
		const custom = await this.db
			.select()
			.from(accountPolicies)
			.where(eq(accountPolicies.accountId, accountId))
			.orderBy(asc(accountPolicies.name));
		const builtIn = Permissions.builtIns(this.catalogue);
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

	/** Removes a member, or lets a member leave. Only owners remove owners; the last owner can't go. */
	async removeMember(actor: Membership, userId: number): Promise<void> {
		if (userId !== actor.userId) Permissions.assertCan(actor, 'members.manage');
		const previous = await this.currentPolicy(actor.accountId, userId);
		if (previous === OWNER && userId !== actor.userId && actor.policy.key !== OWNER) {
			throw Error403('Only an owner can remove an owner');
		}
		const removed = await this.db
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

	/** The user's membership of the account with its resolved policy, or `null` if not a member. */
	async resolveMembership(accountId: number, userId: number): Promise<Membership | null> {
		const [row] = await this.db
			.select({ policy: accountMembers.policy })
			.from(accountMembers)
			.where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
			.limit(1);
		if (!row) return null;
		// A member whose custom policy was somehow removed keeps no permissions rather than failing.
		const policy = (await this.findPolicy(accountId, row.policy)) ?? {
			builtIn: false,
			key: row.policy,
			name: row.policy,
			permissions: [],
		};
		return { accountId, policy, userId };
	}

	async revokeInvite(actor: Membership, email: string): Promise<void> {
		Permissions.assertCan(actor, 'members.invite');
		await this.db
			.delete(accountInvites)
			.where(
				and(
					eq(accountInvites.accountId, actor.accountId),
					eq(accountInvites.email, email.trim().toLowerCase()),
					isNull(accountInvites.acceptedAt)
				)
			);
	}

	/** Creates or updates one of the account's own policies. */
	async savePolicy(
		actor: Membership,
		input: { key: string; name: string; permissions: string[] },
		now = Date.now()
	): Promise<void> {
		Permissions.assertCan(actor, 'policies.manage');
		if (!Permissions.isValidKey(input.key))
			throw Error400('Use 1-40 lowercase letters, digits and dashes');
		const bad = input.permissions.filter((p) => !Permissions.isGrantable(this.catalogue, p));
		if (bad.length) throw Error400(`Unknown permissions: ${bad.join(', ')}`);
		const permissions = [...new Set(input.permissions)].sort();
		await this.db
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

	/** Gives a member another policy. Only owners confer or take away ownership; nobody changes their
	 *  own policy; the last owner stays an owner. */
	async setMemberPolicy(actor: Membership, userId: number, policy: string): Promise<void> {
		Permissions.assertCan(actor, 'members.manage');
		if (userId === actor.userId) throw Error400('You cannot change your own policy');
		if (!(await this.findPolicy(actor.accountId, policy))) throw Error400('Unknown policy');
		const previous = await this.currentPolicy(actor.accountId, userId);
		if ((policy === OWNER || previous === OWNER) && actor.policy.key !== OWNER) {
			throw Error403('Only an owner can change ownership');
		}
		const updated = await this.db
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
}
