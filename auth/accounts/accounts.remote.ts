import { getRequestEvent } from '$app/server';
import { z } from 'zod';

import { Remote } from '../../server/remote-functions';
import { FormResult } from '../../utils/form';
import { auth } from '../config';
import { inviteEmail } from '../emails';
import { authLocals } from '../sessions/handle';
import {
	can,
	createInvite,
	deletePolicy,
	listAccountsForUser,
	listInvites,
	listMembers,
	listPolicies,
	removeMember,
	revokeInvite,
	savePolicy,
	setMemberPolicy,
} from './accounts';
import { requireAccount, requirePermission } from './handle';
import { ACCOUNT_PERMISSIONS } from './permissions';
import { InviteSchema, PolicySchema } from './schemas';

// Account management for the app's pages, acting in the request's account (`createAccountHandle`).
// Each call checks the caller's permissions in `accounts.ts`; these only adapt them to the wire.

/** The accounts the signed-in user belongs to, for an account switcher. */
export const getMyAccounts = Remote.Query(async () => {
	const { user } = authLocals(getRequestEvent());
	return user ? listAccountsForUser(auth().db(), user.id) : [];
});

/** Everything a members page needs, shaped by what the caller may do. */
export const getAccountMembers = Remote.Query(async () => {
	const event = getRequestEvent();
	const { account, membership } = requireAccount(event);
	const db = auth().db();
	return {
		account,
		can: {
			invite: can(membership, 'members.invite'),
			manage: can(membership, 'members.manage'),
			managePolicies: can(membership, 'policies.manage'),
		},
		invites: await listInvites(db, membership),
		me: { policy: membership.policy.key, userId: membership.userId },
		members: await listMembers(db, membership),
		permissions: [...ACCOUNT_PERMISSIONS, ...auth().accounts.permissions],
		policies: await listPolicies(db, auth().accounts, membership.accountId),
	};
});

/** Invites someone by email; the link lands on the app's invite page. */
export const inviteMemberForm = Remote.Form(InviteSchema, async (input) => {
	const event = getRequestEvent();
	const membership = requirePermission(event, 'members.invite');
	const { account } = requireAccount(event);
	const token = await createInvite(auth().db(), auth().accounts, membership, input);
	const url = new URL(auth().invitePath, event.url.origin);
	url.searchParams.set('token', token);
	const inviter = authLocals(event).user?.email ?? 'Someone';
	await auth()
		.email()
		.deliver({
			to: input.email,
			...inviteEmail(auth().emailBrand, { accountName: account.name, inviter, url: url.href }),
		});
	void getAccountMembers().refresh();
	return FormResult.ok(`Invited ${input.email}`);
});

export const revokeInviteCmd = Remote.Cmd(z.object({ email: z.string() }), async ({ email }) => {
	await revokeInvite(auth().db(), requireAccount(getRequestEvent()).membership, email);
	void getAccountMembers().refresh();
});

export const setMemberPolicyCmd = Remote.Cmd(
	z.object({ policy: z.string().min(1).max(40), userId: z.number().int() }),
	async ({ policy, userId }) => {
		const { membership } = requireAccount(getRequestEvent());
		await setMemberPolicy(auth().db(), auth().accounts, membership, userId, policy);
		void getAccountMembers().refresh();
	}
);

export const removeMemberCmd = Remote.Cmd(
	z.object({ userId: z.number().int() }),
	async ({ userId }) => {
		await removeMember(auth().db(), requireAccount(getRequestEvent()).membership, userId);
		void getAccountMembers().refresh();
	}
);

export const savePolicyCmd = Remote.Cmd(PolicySchema, async (input) => {
	const { membership } = requireAccount(getRequestEvent());
	await savePolicy(auth().db(), auth().accounts, membership, input);
	void getAccountMembers().refresh();
});

export const deletePolicyCmd = Remote.Cmd(z.object({ key: z.string() }), async ({ key }) => {
	await deletePolicy(auth().db(), requireAccount(getRequestEvent()).membership, key);
	void getAccountMembers().refresh();
});
