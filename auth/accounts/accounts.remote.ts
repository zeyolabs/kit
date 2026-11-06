import { getRequestEvent } from '$app/server';
import { z } from 'zod';

import { Remote } from '../../server/remote-functions';
import { FormResult } from '../../utils/form';
import { Auth } from '../config';
import { AuthEmails } from '../emails';
import { AuthHandle } from '../sessions/handle';
import { Accounts } from './accounts';
import { AccountHandle } from './handle';
import { Invites } from './invites';
import { Permissions } from './permissions';
import { AccountSchemas } from './schemas';

// Account management for the app's pages, acting in the request's account (`AccountHandle.create`).
// Each call checks the caller's permissions in `accounts.ts`; these only adapt them to the wire.

/** The accounts the signed-in user belongs to, for an account switcher. */
export const getMyAccounts = Remote.Query(async () => {
	const { user } = AuthHandle.locals(getRequestEvent());
	return user ? Accounts.listForUser(Auth.config().db(), user.id) : [];
});

/** Everything a members page needs, shaped by what the caller may do. */
export const getAccountMembers = Remote.Query(async () => {
	const event = getRequestEvent();
	const { account, membership } = AccountHandle.require(event);
	const db = Auth.config().db();
	return {
		account,
		can: {
			invite: Accounts.can(membership, 'members.invite'),
			manage: Accounts.can(membership, 'members.manage'),
			managePolicies: Accounts.can(membership, 'policies.manage'),
		},
		invites: await Invites.list(db, membership),
		me: { policy: membership.policy.key, userId: membership.userId },
		members: await Accounts.listMembers(db, membership),
		permissions: [...Permissions.ACCOUNT, ...Auth.config().accounts.permissions],
		policies: await Accounts.listPolicies(db, Auth.config().accounts, membership.accountId),
	};
});

/** Invites someone by email; the link lands on the app's invite page. */
export const inviteMemberForm = Remote.Form(AccountSchemas.Invite, async (input) => {
	const event = getRequestEvent();
	const membership = AccountHandle.requirePermission(event, 'members.invite');
	const { account } = AccountHandle.require(event);
	const token = await Invites.create(Auth.config().db(), Auth.config().accounts, membership, input);
	const url = new URL(Auth.config().invitePath, event.url.origin);
	url.searchParams.set('token', token);
	const inviter = AuthHandle.locals(event).user?.email ?? 'Someone';
	await Auth.config()
		.email()
		.deliver({
			to: input.email,
			...AuthEmails.invite(Auth.config().emailBrand, {
				accountName: account.name,
				inviter,
				url: url.href,
			}),
		});
	void getAccountMembers().refresh();
	return FormResult.ok(`Invited ${input.email}`);
});

export const revokeInviteCmd = Remote.Cmd(z.object({ email: z.string() }), async ({ email }) => {
	await Invites.revoke(
		Auth.config().db(),
		AccountHandle.require(getRequestEvent()).membership,
		email
	);
	void getAccountMembers().refresh();
});

export const setMemberPolicyCmd = Remote.Cmd(
	z.object({ policy: z.string().min(1).max(40), userId: z.number().int() }),
	async ({ policy, userId }) => {
		const { membership } = AccountHandle.require(getRequestEvent());
		await Accounts.setMemberPolicy(
			Auth.config().db(),
			Auth.config().accounts,
			membership,
			userId,
			policy
		);
		void getAccountMembers().refresh();
	}
);

export const removeMemberCmd = Remote.Cmd(
	z.object({ userId: z.number().int() }),
	async ({ userId }) => {
		await Accounts.removeMember(
			Auth.config().db(),
			AccountHandle.require(getRequestEvent()).membership,
			userId
		);
		void getAccountMembers().refresh();
	}
);

export const savePolicyCmd = Remote.Cmd(AccountSchemas.Policy, async (input) => {
	const { membership } = AccountHandle.require(getRequestEvent());
	await Accounts.savePolicy(Auth.config().db(), Auth.config().accounts, membership, input);
	void getAccountMembers().refresh();
});

export const deletePolicyCmd = Remote.Cmd(z.object({ key: z.string() }), async ({ key }) => {
	await Accounts.deletePolicy(
		Auth.config().db(),
		AccountHandle.require(getRequestEvent()).membership,
		key
	);
	void getAccountMembers().refresh();
});
