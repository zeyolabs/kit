import type { RequestEvent } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';

import { redirect } from '@sveltejs/kit';

import type { AccessConfig } from '../cloudflare/access';
import type { AuthSession, AuthUser } from './sessions';

import { ACCESS_JWT_HEADER, verifyAccessJwt } from '../cloudflare/access';
import { Error401 } from '../utils/errors';
import { auth, sessionCookieAttributes } from './config';
import { deleteSession, needsRenewal, renewSession, validateSession } from './sessions';
import { emailsMatch } from './users';

/** What the handle puts on `event.locals`. Apps extend it: `interface Locals extends AuthLocals`. */
export type AuthLocals = {
	/** The Cloudflare Access email when Access sits in front, else null. */
	accessEmail: null | string;
	session: AuthSession | null;
	user: AuthUser | null;
};

export type AuthHandleOptions = {
	/** Cloudflare Access in front of the app: return its config to require a valid Access JWT whose
	 *  email matches the session user's, or `null` when the app is public. */
	access?: () => AccessConfig | null;
	/** Local dev only (no Access JWT on localhost): the email Access would have vouched for. */
	devAccessEmail?: () => null | string;
	/** Reachable without a session. Default: the login page and `/auth/*` (the auth routes). */
	publicPaths?: readonly string[];
};

export const authLocals = (event: RequestEvent) => event.locals as unknown as AuthLocals;

const matches = (pathname: string, paths: readonly string[]) =>
	paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/** Remote calls, non-GET requests and other fetches get a 401, not a redirect to a login page. */
const isApiRequest = (event: RequestEvent) =>
	event.request.method !== 'GET' || event.url.pathname.startsWith('/_app/remote');

/**
 * The auth gate, for `sequence(...)` after the context handle:
 *   1. With Access configured, its JWT must verify (403 otherwise, even on public paths).
 *   2. The session cookie resolves to a live session whose user is still allowed (and matches the
 *      Access email); anything else is dropped and the cookie cleared.
 *   3. Without a session, public paths render; pages redirect to the login page with `next`; API
 *      requests get a 401.
 * A session in its second half is renewed (sliding expiry).
 */
export function createAuthHandle(options: AuthHandleOptions = {}): Handle {
	return async ({ event, resolve }) => {
		const config = auth();
		const locals = authLocals(event);
		locals.accessEmail = null;
		locals.session = null;
		locals.user = null;

		const devEmail = options.devAccessEmail?.() ?? null;
		const access = devEmail ? null : (options.access?.() ?? null);
		if (devEmail) locals.accessEmail = devEmail;
		if (access) {
			const jwt = event.request.headers.get(ACCESS_JWT_HEADER);
			if (!jwt) return new Response('Forbidden', { status: 403 });
			try {
				locals.accessEmail = (await verifyAccessJwt(jwt, access)).email;
			} catch {
				return new Response('Forbidden', { status: 403 });
			}
		}

		const db = config.db();
		const token = event.cookies.get(config.cookieName);
		if (token) {
			const live = await validateSession(db, token);
			const ok =
				live &&
				config.isAllowed(live.user.email) &&
				(!locals.accessEmail || emailsMatch(locals.accessEmail, live.user.email));
			if (ok) {
				locals.session = live.session;
				locals.user = live.user;
				if (needsRenewal(live.session.expiresAt, Date.now())) {
					const expiresAt = await renewSession(db, live.session.id);
					locals.session = { ...live.session, expiresAt };
					event.cookies.set(config.cookieName, token, {
						...sessionCookieAttributes,
						expires: new Date(expiresAt),
					});
				}
			} else {
				if (live) await deleteSession(db, live.session.id);
				event.cookies.delete(config.cookieName, { path: '/' });
			}
		}

		const publicPaths = options.publicPaths ?? [config.loginPath, '/auth'];
		if (locals.user || matches(event.url.pathname, publicPaths)) return resolve(event);
		if (isApiRequest(event)) return new Response('Unauthorized', { status: 401 });
		const next = event.url.pathname + event.url.search;
		redirect(303, `${config.loginPath}?next=${encodeURIComponent(next)}`);
	};
}

/** The signed-in user, or a thrown 401 `ServiceError`. For remote functions behind the handle. */
export function requireUser(event: RequestEvent): AuthUser {
	const { user } = authLocals(event);
	if (!user) throw Error401('Sign in first');
	return user;
}
