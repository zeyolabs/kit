import type { RequestEvent } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';

import { error } from '@sveltejs/kit';

import type { AccountSummary, Membership } from './accounts';

import { Error403, Error404 } from '../../utils/errors';
import { auth } from '../config';
import { authLocals } from '../sessions/handle';
import { can, findAccountBySlug, resolveMembership } from './accounts';

// Which account a request acts in, and the signed-in user's membership of it. Runs after
// `createAuthHandle`. The account comes from the request (a route param, a fixed slug, ...) and
// never from the session, so switching accounts is just navigating.

export type AccountLocals = {
	/** The account this request acts in, or null where the route has none. */
	account: AccountSummary | null;
	/** The signed-in user's membership of `account`. */
	membership: Membership | null;
};

export const accountLocals = (event: RequestEvent) => event.locals as unknown as AccountLocals;

/**
 * The account slug from the route param `param` (e.g. `/[account]/...`). Remote-function calls
 * have no route params, so for those it reads the same path segment of the calling page (the
 * `Referer`), which SvelteKit always sends for same-origin fetches.
 */
export function slugFromRoute(param = 'account', segment = 0) {
	return (event: RequestEvent): null | string => {
		const fromParam = event.params[param as keyof typeof event.params];
		if (typeof fromParam === 'string') return fromParam;
		if (!event.url.pathname.startsWith('/_app/remote')) return null;
		const referer = event.request.headers.get('referer');
		if (!referer) return null;
		const page = new URL(referer);
		if (page.origin !== event.url.origin) return null;
		return page.pathname.split('/').filter(Boolean)[segment] ?? null;
	};
}

/**
 * Sets `locals.account` and `locals.membership`. A slug for an account that doesn't exist, or that
 * the user doesn't belong to, is a 404 (the same answer, so slugs can't be probed).
 */
export function createAccountHandle(options: {
	/** The account slug for a request, or null when it isn't in an account. */
	slug: (event: RequestEvent) => null | string;
}): Handle {
	return async ({ event, resolve }) => {
		const locals = accountLocals(event);
		locals.account = null;
		locals.membership = null;
		const { user } = authLocals(event);
		const slug = user ? options.slug(event) : null;
		if (slug && user) {
			const account = await findAccountBySlug(auth().db(), slug);
			const membership =
				account && (await resolveMembership(auth().db(), auth().accounts, account.id, user.id));
			if (!account || !membership) error(404, 'Not found');
			locals.account = account;
			locals.membership = membership;
		}
		return resolve(event);
	};
}

/** The request's account and membership, or a 404 `ServiceError`. */
export function requireAccount(event: RequestEvent): {
	account: AccountSummary;
	membership: Membership;
} {
	const { account, membership } = accountLocals(event);
	if (!account || !membership) throw Error404('Not found');
	return { account, membership };
}

/** The request's membership if it grants `permission`, else a 403 `ServiceError`. */
export function requirePermission(event: RequestEvent, permission: string): Membership {
	const { membership } = requireAccount(event);
	if (!can(membership, permission)) throw Error403('You do not have permission to do that');
	return membership;
}
