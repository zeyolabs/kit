import { and, asc, eq, gt, isNull } from 'drizzle-orm';

import type { AuthDb } from '../config';
import type { AccountSummary, Membership } from './accounts';
import type { PermissionCatalogue } from './permissions';

import { Crypto } from '../../utils/crypto';
import { Error400, Error403, Error404, Error409 } from '../../utils/errors';
import { accountInvites, accountMembers, accounts, users } from '../schema';
import { Accounts } from './accounts';

// Invitations to join an account: an emailed single-use link, accepted only by a session for the
// invited email.

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const OWNER = 'owner';

/** Invites `email` with `policy`; replaces any earlier pending invite for that email. Returns the
 *  token for the emailed link. */
async function createInvite(
	db: AuthDb,
	catalogue: PermissionCatalogue,
	actor: Membership,
	input: { email: string; policy: string },
	now = Date.now()
): Promise<string> {
	Accounts.assertCan(actor, 'members.invite');
	const email = input.email.trim().toLowerCase();
	if (input.policy === OWNER && actor.policy.key !== OWNER) {
		throw Error403('Only an owner can invite an owner');
	}
	if (!(await Accounts.findPolicy(db, catalogue, actor.accountId, input.policy))) {
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

async function listInvites(db: AuthDb, actor: Membership, now = Date.now()) {
	Accounts.assertCan(actor, 'members.read');
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

async function revokeInvite(db: AuthDb, actor: Membership, email: string): Promise<void> {
	Accounts.assertCan(actor, 'members.invite');
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
async function findInvite(db: AuthDb, token: string, now = Date.now()) {
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
async function acceptInvite(
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
	await Accounts.addMember(db, invite.account.id, user.id, used.policy, now);
	return invite.account;
}

export const Invites = {
	accept: acceptInvite,
	create: createInvite,
	find: findInvite,
	list: listInvites,
	revoke: revokeInvite,
	TTL_MS: INVITE_TTL_MS,
};
