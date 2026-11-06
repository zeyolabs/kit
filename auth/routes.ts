import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

import { json, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthUser } from './sessions';

import { logger } from '../server/logger';
import { Schema } from '../utils/schema';
import { auth, FRESH_SESSION_MS, sessionCookieAttributes } from './config';
import { authLocals } from './handle';
import { consumeMagicLinkToken, issueMagicLinkToken, MAGIC_LINK_TTL_MS } from './magic-link';
import {
	authenticationOptions,
	AuthenticationResponse,
	deletePasskey,
	findPasskey,
	listPasskeys,
	newChallenge,
	PasskeyError,
	recordPasskeyUse,
	registrationOptions,
	RegistrationResponse,
	type RelyingParty,
	savePasskey,
	verifyAuthentication,
	verifyRegistration,
} from './passkeys';
import { users } from './schema';
import { createSession, deleteSession } from './sessions';
import { emailsMatch, findOrCreateUser } from './users';

// The auth endpoints, mounted by the app with one file:
//   src/routes/auth/[...path]/+server.ts:  export { POST } from '@zeyolabs/kit/auth/routes';
//
//   POST /auth/email                  form {email, next}  -> emails a link, 303 login?sent=1
//   POST /auth/verify                 form {token, next}  -> uses the link, signs in, 303 next
//   POST /auth/logout                 form                -> 303 login
//   POST /auth/passkey/login-options  json                -> request options
//   POST /auth/passkey/login          json {credential, next} -> signs in, {redirect}
//   POST /auth/passkey/register-options json              -> creation options (fresh session)
//   POST /auth/passkey/register       json {credential, name} -> {ok}
//   POST /auth/passkey/delete         form {id, next}     -> 303 next
//
// The emailed link opens the login page (`?token=`), which posts it here from a button: mail
// scanners that prefetch links can't burn the token or sign anyone in.

const CHALLENGE_MAX_AGE = 5 * 60;

/** Login-page error codes; the app's login page maps them to copy with `loginErrorMessage`. */
export type LoginError = 'expired' | 'mismatch' | 'not_allowed' | 'passkey' | 'send';

const challengeCookie = () => `${auth().cookieName}_challenge`;

function relyingParty(event: RequestEvent): RelyingParty {
	const { appName, passkeyRpId } = auth();
	return { id: passkeyRpId ?? event.url.hostname, name: appName, origin: event.url.origin };
}

/** A same-site path to go to after sign-in: never another origin (`//x`, `/\x`, `https:`). */
export function safeNext(next: unknown): string {
	if (typeof next !== 'string' || !next.startsWith('/') || /^\/[/\\]/.test(next)) return '/';
	return next;
}

function toLogin(error: LoginError | null, next: string, sent = false): never {
	const params = new URLSearchParams();
	if (error) params.set('error', error);
	if (sent) params.set('sent', '1');
	if (next !== '/') params.set('next', next);
	const query = params.toString();
	redirect(303, `${auth().loginPath}${query ? `?${query}` : ''}`);
}

/** Checks a would-be session user against the allowlist and the Access identity. */
function refusal(event: RequestEvent, email: string): LoginError | null {
	if (!auth().isAllowed(email)) return 'not_allowed';
	const { accessEmail } = authLocals(event);
	if (accessEmail && !emailsMatch(accessEmail, email)) return 'mismatch';
	return null;
}

async function signIn(event: RequestEvent, user: AuthUser): Promise<void> {
	const { expiresAt, token } = await createSession(auth().db(), user.id);
	event.cookies.set(auth().cookieName, token, {
		...sessionCookieAttributes,
		expires: new Date(expiresAt),
	});
}

function setChallenge(event: RequestEvent): string {
	const challenge = newChallenge();
	event.cookies.set(challengeCookie(), challenge, {
		...sessionCookieAttributes,
		maxAge: CHALLENGE_MAX_AGE,
		path: '/auth/passkey',
		sameSite: 'strict',
	});
	return challenge;
}

/** The pending challenge, used up: each one answers exactly one ceremony. */
function takeChallenge(event: RequestEvent): string {
	const challenge = event.cookies.get(challengeCookie());
	event.cookies.delete(challengeCookie(), { path: '/auth/passkey' });
	if (!challenge) throw new PasskeyError('No pending challenge');
	return challenge;
}

/** Adding or removing a passkey needs a session, and adding one needs a recent sign-in. */
function sessionUser(event: RequestEvent, fresh: boolean): AuthUser | Response {
	const { session, user } = authLocals(event);
	if (!session || !user) return json({ message: 'Sign in first' }, { status: 401 });
	if (fresh && Date.now() - session.createdAt > FRESH_SESSION_MS) {
		return json(
			{ message: 'For security, sign in again before adding a passkey', reauth: true },
			{ status: 403 }
		);
	}
	return user;
}

async function emailLink(event: RequestEvent): Promise<never> {
	const form = await event.request.formData();
	const next = safeNext(form.get('next'));
	const parsed = Schema.Email.safeParse(form.get('email'));
	if (!parsed.success) toLogin('send', next);
	const email = parsed.data;

	const refused = refusal(event, email);
	// Unknown emails get the same answer as known ones, so the form can't probe the allowlist.
	if (refused === 'not_allowed') toLogin(null, next, true);
	if (refused) toLogin(refused, next);

	const token = await issueMagicLinkToken(auth().db(), email);
	if (token) {
		const url = new URL(auth().loginPath, event.url.origin);
		url.searchParams.set('token', token);
		if (next !== '/') url.searchParams.set('next', next);
		try {
			await auth().sendMagicLink({
				email,
				expiresInMinutes: MAGIC_LINK_TTL_MS / 60_000,
				url: url.href,
			});
		} catch (err) {
			logger.error(err, { op: 'auth.magic-link.send' });
			toLogin('send', next);
		}
	}
	toLogin(null, next, true);
}

async function verifyLink(event: RequestEvent): Promise<never> {
	const form = await event.request.formData();
	const next = safeNext(form.get('next'));
	const email = await consumeMagicLinkToken(auth().db(), String(form.get('token') ?? ''));
	if (!email) toLogin('expired', next);
	const refused = refusal(event, email);
	if (refused) toLogin(refused, next);
	await signIn(event, await findOrCreateUser(auth().db(), email));
	redirect(303, next);
}

async function logout(event: RequestEvent): Promise<never> {
	const { session } = authLocals(event);
	if (session) await deleteSession(auth().db(), session.id);
	event.cookies.delete(auth().cookieName, { path: '/' });
	redirect(303, auth().loginPath);
}

async function passkeyLogin(event: RequestEvent): Promise<Response> {
	const body = z
		.object({ credential: AuthenticationResponse, next: z.string().optional() })
		.safeParse(await event.request.json().catch(() => null));
	if (!body.success) return json({ message: 'Malformed request' }, { status: 400 });
	const db = auth().db();
	try {
		const challenge = takeChallenge(event);
		const passkey = await findPasskey(db, body.data.credential.rawId);
		if (!passkey) throw new PasskeyError('Unknown passkey');
		const signCount = verifyAuthentication(
			body.data.credential,
			challenge,
			relyingParty(event),
			passkey
		);
		const [user] = await db.select().from(users).where(eq(users.id, passkey.userId)).limit(1);
		const refused = refusal(event, user.email);
		if (refused) return json({ code: refused, message: 'Not allowed' }, { status: 403 });
		await recordPasskeyUse(db, passkey.id, signCount);
		await signIn(event, user);
		return json({ redirect: safeNext(body.data.next) });
	} catch (err) {
		if (!(err instanceof PasskeyError)) throw err;
		logger.warn(`passkey sign-in refused: ${err.message}`);
		return json({ message: 'That passkey could not be verified' }, { status: 400 });
	}
}

async function passkeyRegisterOptions(event: RequestEvent): Promise<Response> {
	const user = sessionUser(event, true);
	if (user instanceof Response) return user;
	const existing = await listPasskeys(auth().db(), user.id);
	const ids = existing.map((p) => p.id);
	return json(registrationOptions(relyingParty(event), user, setChallenge(event), ids));
}

async function passkeyRegister(event: RequestEvent): Promise<Response> {
	const user = sessionUser(event, true);
	if (user instanceof Response) return user;
	const body = z
		.object({ credential: RegistrationResponse, name: z.string().trim().max(60).optional() })
		.safeParse(await event.request.json().catch(() => null));
	if (!body.success) return json({ message: 'Malformed request' }, { status: 400 });
	try {
		const credential = verifyRegistration(
			body.data.credential,
			takeChallenge(event),
			relyingParty(event)
		);
		await savePasskey(auth().db(), user.id, body.data.name || 'Passkey', credential);
		return json({ ok: true });
	} catch (err) {
		if (!(err instanceof PasskeyError)) throw err;
		logger.warn(`passkey registration refused: ${err.message}`);
		return json({ message: 'That passkey could not be added' }, { status: 400 });
	}
}

async function passkeyDelete(event: RequestEvent): Promise<never> {
	const form = await event.request.formData();
	const next = safeNext(form.get('next'));
	const user = sessionUser(event, false);
	if (user instanceof Response) toLogin(null, next);
	await deletePasskey(auth().db(), user.id, String(form.get('id') ?? ''));
	redirect(303, next);
}

const handlers: Record<string, (event: RequestEvent) => Promise<Response>> = {
	email: emailLink,
	logout,
	'passkey/delete': passkeyDelete,
	'passkey/login': passkeyLogin,
	'passkey/login-options': async (event) =>
		json(authenticationOptions(relyingParty(event), setChallenge(event))),
	'passkey/register': passkeyRegister,
	'passkey/register-options': passkeyRegisterOptions,
	verify: verifyLink,
};

export const POST: RequestHandler = async (event) => {
	// SvelteKit's CSRF check only covers form posts; the JSON endpoints need the same guard.
	if (event.request.headers.get('origin') !== event.url.origin) {
		return new Response('Cross-site request refused', { status: 403 });
	}
	const handler = handlers[event.params.path ?? ''];
	if (!handler) return new Response('Not found', { status: 404 });
	return handler(event);
};

const LOGIN_ERRORS: Record<LoginError, string> = {
	expired: 'That sign-in link has expired or was already used. Request a new one.',
	mismatch: 'Sign in with the same email you used for Cloudflare Access.',
	not_allowed: 'That email is not allowed to sign in here.',
	passkey: 'That passkey could not be verified. Try again or use an email link.',
	send: 'We could not send the email. Check the address and try again.',
};

/** Copy for a login page's `?error=` code; `null` for none or an unknown one. */
export function loginErrorMessage(code: null | string): null | string {
	return code && code in LOGIN_ERRORS ? LOGIN_ERRORS[code as LoginError] : null;
}
