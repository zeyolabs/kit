import type { RequestEvent } from '@sveltejs/kit';

import { redirect } from '@sveltejs/kit';

import { findInvite } from '../accounts/accounts';
import { auth, FRESH_SESSION_MS } from '../config';
import { listPasskeys } from '../passkeys/passkeys';
import { authLocals } from '../sessions/handle';
import { loginErrorMessage, safeNext } from './routes';

type LoadEvent = Pick<RequestEvent, 'locals' | 'url'>;

/** The login page's server load: `export { loginLoad as load } from '@zeyolabs/kit/auth/sveltekit/loads'`.
 *  A signed-in visitor goes straight on to `next`, unless they arrived with a link token. */
export function loginLoad(event: LoadEvent) {
	const { accessEmail, user } = authLocals(event as RequestEvent);
	const params = event.url.searchParams;
	const next = safeNext(params.get('next') ?? '/');
	const token = params.get('token');
	if (user && !token) redirect(303, next);
	return {
		accessEmail,
		error: loginErrorMessage(params.get('error')),
		next,
		sent: params.has('sent'),
		token,
	};
}

/** For a settings page that manages passkeys. `fresh` says whether adding one is allowed now
 *  without signing in again. */
export async function passkeysLoad(event: LoadEvent) {
	const { session, user } = authLocals(event as RequestEvent);
	if (!session || !user) redirect(303, auth().loginPath);
	return {
		fresh: Date.now() - session.createdAt <= FRESH_SESSION_MS,
		passkeys: await listPasskeys(auth().db(), user.id),
	};
}

/** The invite page's load (`/invite?token=`): who invited whom to what. Signed-out visitors are
 *  already sent to the login page by the auth handle and come back here. */
export async function inviteLoad(event: LoadEvent) {
	const { user } = authLocals(event as RequestEvent);
	const token = event.url.searchParams.get('token') ?? '';
	const invite = await findInvite(auth().db(), token);
	return {
		error: event.url.searchParams.get('error'),
		invite: invite && { accountName: invite.account.name, email: invite.email },
		signedInAs: user?.email ?? null,
		token,
	};
}
