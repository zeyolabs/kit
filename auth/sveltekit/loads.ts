import type { RequestEvent } from '@sveltejs/kit';

import { redirect } from '@sveltejs/kit';

import { Invites } from '../accounts/invites';
import { Auth } from '../config';
import { AuthHandle } from '../sessions/handle';
import { Passkeys } from '../sessions/passkeys/passkeys';
import { Login } from './login';

type LoadEvent = Pick<RequestEvent, 'locals' | 'url'>;

/** The login page's server load: `export { loginLoad as load } from '@zeyolabs/kit/auth/sveltekit/loads'`.
 *  A signed-in visitor goes straight on to `next`, unless they arrived with a link token. */
function loginLoad(event: LoadEvent) {
	const { accessEmail, user } = AuthHandle.locals(event as RequestEvent);
	const params = event.url.searchParams;
	const next = Login.safeNext(params.get('next') ?? '/');
	const token = params.get('token');
	if (user && !token) redirect(303, next);
	return {
		accessEmail,
		error: Login.errorMessage(params.get('error')),
		next,
		sent: params.has('sent'),
		token,
	};
}

/** For a settings page that manages passkeys. `fresh` says whether adding one is allowed now
 *  without signing in again. */
async function passkeysLoad(event: LoadEvent) {
	const { session, user } = AuthHandle.locals(event as RequestEvent);
	if (!session || !user) redirect(303, Auth.config().loginPath);
	return {
		fresh: Date.now() - session.createdAt <= Passkeys.FRESH_SESSION_MS,
		passkeys: await Passkeys.list(Auth.config().db(), user.id),
	};
}

/** The invite page's load (`/invite?token=`): who invited whom to what. Signed-out visitors are
 *  already sent to the login page by the auth handle and come back here. */
async function inviteLoad(event: LoadEvent) {
	const { user } = AuthHandle.locals(event as RequestEvent);
	const token = event.url.searchParams.get('token') ?? '';
	const invite = await Invites.find(Auth.config().db(), token);
	return {
		error: event.url.searchParams.get('error'),
		invite: invite && { accountName: invite.account.name, email: invite.email },
		signedInAs: user?.email ?? null,
		token,
	};
}

export const AuthLoads = {
	invite: inviteLoad,
	login: loginLoad,
	passkeys: passkeysLoad,
};
