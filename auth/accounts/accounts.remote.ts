import { getRequestEvent } from '$app/server';
import { z } from 'zod';

import { Remote } from '../../server/remote-functions';
import { FormResult } from '../../utils/form';
import { Schema } from '../../utils/schema';
import { Auth } from '../config';
import { AuthEmails } from '../emails';
import { AuthHandle } from '../sessions/handle';
import { AccountService } from './accounts';
import { AccountHandle } from './handle';
import { Permissions } from './permissions';
import { AccountSchemas } from './schemas';

// Account management for the app's pages, acting in the request's account (`AccountHandle.create`).
// Each call checks the caller's permissions in `accounts.ts`; these only adapt them to the wire.

/** The accounts the signed-in user belongs to, for an account switcher. */
export const getMyAccounts = Remote.Query(async () => {
	const { user } = AuthHandle.locals(getRequestEvent());
	if (!user) return [];
	return new AccountService(Auth.config().db(), Auth.config().accounts).listForUser(user.id);
});

/** Everything a members page needs, shaped by what the caller may do. */
export const getAccountMembers = Remote.Query(async () => {
	const event = getRequestEvent();
	const { account, membership } = AccountHandle.require(event);
	const accounts = new AccountService(Auth.config().db(), Auth.config().accounts);
	return {
		account,
		can: {
			invite: Permissions.can(membership, 'members.invite'),
			manage: Permissions.can(membership, 'members.manage'),
			managePolicies: Permissions.can(membership, 'policies.manage'),
		},
		invites: await accounts.listInvites(membership),
		me: { policy: membership.policy.key, userId: membership.userId },
		members: await accounts.listMembers(membership),
		permissions: [...Permissions.ACCOUNT, ...Auth.config().accounts.permissions],
		policies: await accounts.listPolicies(membership.accountId),
	};
});

/** Invites someone by email; the link lands on the app's invite page. */
export const inviteMemberForm = Remote.Form(AccountSchemas.Invite, async (input) => {
	const event = getRequestEvent();
	const membership = AccountHandle.requirePermission(event, 'members.invite');
	const { account } = AccountHandle.require(event);
	const accounts = new AccountService(Auth.config().db(), Auth.config().accounts);
	const token = await accounts.createInvite(membership, input);
	const url = new URL(Auth.config().invitePath, event.url.origin);
	url.searchParams.set('token', token);
	const inviter = AuthHandle.locals(event).user?.email ?? 'Someone';
	const { emailBrand, emailFrom } = Auth.config();
	await Auth.config()
		.email()
		.deliver({
			from: emailFrom,
			fromName: emailBrand.name,
			to: input.email,
			...AuthEmails.invite(emailBrand, {
				accountName: account.name,
				inviter,
				url: url.href,
			}),
		});
	void getAccountMembers().refresh();
	return FormResult.ok(`Invited ${input.email}`);
});

export const revokeInviteCmd = Remote.Cmd(z.object({ email: z.string() }), async ({ email }) => {
	const accounts = new AccountService(Auth.config().db(), Auth.config().accounts);
	await accounts.revokeInvite(AccountHandle.require(getRequestEvent()).membership, email);
	void getAccountMembers().refresh();
});

export const setMemberPolicyCmd = Remote.Cmd(
	z.object({ policy: z.string().min(1).max(40), userId: Schema.Id }),
	async ({ policy, userId }) => {
		const { membership } = AccountHandle.require(getRequestEvent());
		const accounts = new AccountService(Auth.config().db(), Auth.config().accounts);
		await accounts.setMemberPolicy(membership, userId, policy);
		void getAccountMembers().refresh();
	}
);

export const removeMemberCmd = Remote.Cmd(z.object({ userId: Schema.Id }), async ({ userId }) => {
	const accounts = new AccountService(Auth.config().db(), Auth.config().accounts);
	await accounts.removeMember(AccountHandle.require(getRequestEvent()).membership, userId);
	void getAccountMembers().refresh();
});

/** Creates or edits one of the account's own policies (the policy editor's form). */
export const savePolicyForm = Remote.Form(AccountSchemas.PolicyForm, async (input) => {
	const { membership } = AccountHandle.require(getRequestEvent());
	const accounts = new AccountService(Auth.config().db(), Auth.config().accounts);
	await accounts.savePolicy(membership, input);
	void getAccountMembers().refresh();
	return FormResult.ok(`Saved ${input.name}`);
});

/** @deprecated Use `savePolicyForm`; kept until `@zeyolabs/ui`'s policy editor has moved to it. */
export const savePolicyCmd = Remote.Cmd(AccountSchemas.Policy, async (input) => {
	const { membership } = AccountHandle.require(getRequestEvent());
	const accounts = new AccountService(Auth.config().db(), Auth.config().accounts);
	await accounts.savePolicy(membership, input);
	void getAccountMembers().refresh();
});

export const deletePolicyCmd = Remote.Cmd(z.object({ key: z.string() }), async ({ key }) => {
	const accounts = new AccountService(Auth.config().db(), Auth.config().accounts);
	await accounts.deletePolicy(AccountHandle.require(getRequestEvent()).membership, key);
	void getAccountMembers().refresh();
});
