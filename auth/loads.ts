import type { RequestEvent } from '@sveltejs/kit';

import { redirect } from '@sveltejs/kit';

import { auth, FRESH_SESSION_MS } from './config';
import { authLocals } from './handle';
import { listPasskeys } from './passkeys';
import { loginErrorMessage, safeNext } from './routes';

type LoadEvent = Pick<RequestEvent, 'locals' | 'url'>;

/** The login page's server load: `export { loginLoad as load } from '@zeyolabs/kit/auth/loads'`.
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
