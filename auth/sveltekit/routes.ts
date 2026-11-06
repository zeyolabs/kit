import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

import { json, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthUser } from '../sessions/sessions';
import type { LoginError } from './login';

import { logger } from '../../server/logger';
import { ServiceError } from '../../utils/errors';
import { Schema } from '../../utils/schema';
import { Invites } from '../accounts/invites';
import { Auth } from '../config';
import { AuthEmails } from '../emails';
import { users } from '../schema';
import { AuthHandle } from '../sessions/handle';
import { MagicLink } from '../sessions/magic-link/magic-link';
import {
	AuthenticationResponse,
	PasskeyError,
	RegistrationResponse,
	type RelyingParty,
} from '../sessions/passkeys/passkeys';
import { Passkeys } from '../sessions/passkeys/passkeys';
import { Sessions } from '../sessions/sessions';
import { Users } from '../users';
import { Login } from './login';

// The auth endpoints, mounted by the app with one file:
//   src/routes/auth/[...path]/+server.ts:  export { POST } from '@zeyolabs/kit/auth/sveltekit/routes';
//
//   POST /auth/email                  form {email, next}  -> emails a link, 303 login?sent=1
//   POST /auth/verify                 form {token, next}  -> uses the link, signs in, 303 next
//   POST /auth/logout                 form                -> 303 login
//   POST /auth/passkey/login-options  json                -> request options
//   POST /auth/passkey/login          json {credential, next} -> signs in, {redirect}
//   POST /auth/passkey/register-options json              -> creation options (fresh session)
//   POST /auth/passkey/register       json {credential, name} -> {ok}
//   POST /auth/passkey/delete         form {id, next}     -> 303 next
//   POST /auth/invite/accept          form {token}        -> joins the account, 303 its home
//
// The emailed link opens the login page (`?token=`), which posts it here from a button: mail
// scanners that prefetch links can't burn the token or sign anyone in.

const CHALLENGE_MAX_AGE = 5 * 60;

const challengeCookie = () => `${Auth.config().cookieName}_challenge`;

function relyingParty(event: RequestEvent): RelyingParty {
	const { appName, passkeyRpId } = Auth.config();
	return { id: passkeyRpId ?? event.url.hostname, name: appName, origin: event.url.origin };
}

function toLogin(error: LoginError | null, next: string, sent = false): never {
	const params = new URLSearchParams();
	if (error) params.set('error', error);
	if (sent) params.set('sent', '1');
	if (next !== '/') params.set('next', next);
	const query = params.toString();
	redirect(303, `${Auth.config().loginPath}${query ? `?${query}` : ''}`);
}

/** Checks a would-be session user against the allowlist and the Access identity. */
async function refusal(event: RequestEvent, email: string): Promise<LoginError | null> {
	if (!(await Auth.config().isAllowed(email))) return 'not_allowed';
	const { accessEmail } = AuthHandle.locals(event);
	if (accessEmail && !Users.emailsMatch(accessEmail, email)) return 'mismatch';
	return null;
}

async function signIn(event: RequestEvent, user: AuthUser): Promise<void> {
	const { expiresAt, token } = await Sessions.create(Auth.config().db(), user.id);
	event.cookies.set(Auth.config().cookieName, token, {
		...Sessions.cookieAttributes,
		domain: Auth.config().cookieDomain,
		expires: new Date(expiresAt),
	});
	await Auth.config().onSignIn?.(user);
}

function setChallenge(event: RequestEvent): string {
	const challenge = Passkeys.newChallenge();
	event.cookies.set(challengeCookie(), challenge, {
		...Sessions.cookieAttributes,
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
	const { session, user } = AuthHandle.locals(event);
	if (!session || !user) return json({ message: 'Sign in first' }, { status: 401 });
	if (fresh && Date.now() - session.createdAt > Passkeys.FRESH_SESSION_MS) {
		return json(
			{ message: 'For security, sign in again before adding a passkey', reauth: true },
			{ status: 403 }
		);
	}
	return user;
}

async function emailLink(event: RequestEvent): Promise<never> {
	const form = await event.request.formData();
	const next = Login.safeNext(form.get('next'));
	const parsed = Schema.Email.safeParse(form.get('email'));
	if (!parsed.success) toLogin('send', next);
	const email = parsed.data;

	const refused = await refusal(event, email);
	// Unknown emails get the same answer as known ones, so the form can't probe the allowlist.
	if (refused === 'not_allowed') toLogin(null, next, true);
	if (refused) toLogin(refused, next);

	const token = await MagicLink.issue(Auth.config().db(), email);
	if (token) {
		const url = new URL(Auth.config().loginPath, event.url.origin);
		url.searchParams.set('token', token);
		if (next !== '/') url.searchParams.set('next', next);
		try {
			const message = { email, expiresInMinutes: MagicLink.TTL_MS / 60_000, url: url.href };
			await Auth.config()
				.email()
				.deliver({ to: email, ...AuthEmails.magicLink(Auth.config().emailBrand, message) });
		} catch (err) {
			logger.error(err, { op: 'auth.magic-link.send' });
			toLogin('send', next);
		}
	}
	toLogin(null, next, true);
}

async function verifyLink(event: RequestEvent): Promise<never> {
	const form = await event.request.formData();
	const next = Login.safeNext(form.get('next'));
	const email = await MagicLink.consume(Auth.config().db(), String(form.get('token') ?? ''));
	if (!email) toLogin('expired', next);
	const refused = await refusal(event, email);
	if (refused) toLogin(refused, next);
	await signIn(event, await Users.findOrCreate(Auth.config().db(), email));
	redirect(303, next);
}

async function logout(event: RequestEvent): Promise<never> {
	const { session } = AuthHandle.locals(event);
	if (session) await Sessions.delete(Auth.config().db(), session.id);
	event.cookies.delete(Auth.config().cookieName, { domain: Auth.config().cookieDomain, path: '/' });
	redirect(303, Auth.config().loginPath);
}

async function passkeyLogin(event: RequestEvent): Promise<Response> {
	const body = z
		.object({ credential: AuthenticationResponse, next: z.string().optional() })
		.safeParse(await event.request.json().catch(() => null));
	if (!body.success) return json({ message: 'Malformed request' }, { status: 400 });
	const db = Auth.config().db();
	try {
		const challenge = takeChallenge(event);
		const passkey = await Passkeys.find(db, body.data.credential.rawId);
		if (!passkey) throw new PasskeyError('Unknown passkey');
		const signCount = Passkeys.verifyAuthentication(
			body.data.credential,
			challenge,
			relyingParty(event),
			passkey
		);
		const [user] = await db.select().from(users).where(eq(users.id, passkey.userId)).limit(1);
		const refused = await refusal(event, user.email);
		if (refused) return json({ code: refused, message: 'Not allowed' }, { status: 403 });
		await Passkeys.recordUse(db, passkey.id, signCount);
		await signIn(event, user);
		return json({ redirect: Login.safeNext(body.data.next) });
	} catch (err) {
		if (!(err instanceof PasskeyError)) throw err;
		logger.warn(`passkey sign-in refused: ${err.message}`);
		return json({ message: 'That passkey could not be verified' }, { status: 400 });
	}
}

async function passkeyRegisterOptions(event: RequestEvent): Promise<Response> {
	const user = sessionUser(event, true);
	if (user instanceof Response) return user;
	const existing = await Passkeys.list(Auth.config().db(), user.id);
	const ids = existing.map((p) => p.id);
	return json(Passkeys.registrationOptions(relyingParty(event), user, setChallenge(event), ids));
}

async function passkeyRegister(event: RequestEvent): Promise<Response> {
	const user = sessionUser(event, true);
	if (user instanceof Response) return user;
	const body = z
		.object({ credential: RegistrationResponse, name: z.string().trim().max(60).optional() })
		.safeParse(await event.request.json().catch(() => null));
	if (!body.success) return json({ message: 'Malformed request' }, { status: 400 });
	try {
		const credential = Passkeys.verifyRegistration(
			body.data.credential,
			takeChallenge(event),
			relyingParty(event)
		);
		await Passkeys.save(Auth.config().db(), user.id, body.data.name || 'Passkey', credential);
		return json({ ok: true });
	} catch (err) {
		if (!(err instanceof PasskeyError)) throw err;
		logger.warn(`passkey registration refused: ${err.message}`);
		return json({ message: 'That passkey could not be added' }, { status: 400 });
	}
}

async function passkeyDelete(event: RequestEvent): Promise<never> {
	const form = await event.request.formData();
	const next = Login.safeNext(form.get('next'));
	const user = sessionUser(event, false);
	if (user instanceof Response) toLogin(null, next);
	await Passkeys.delete(Auth.config().db(), user.id, String(form.get('id') ?? ''));
	redirect(303, next);
}

/** Accepts an invite for the signed-in user (the invite page posts here) and opens the account. */
async function invite(event: RequestEvent): Promise<never> {
	const form = await event.request.formData();
	const token = String(form.get('token') ?? '');
	const { user } = AuthHandle.locals(event);
	const invitePage = `${Auth.config().invitePath}?token=${encodeURIComponent(token)}`;
	if (!user) toLogin(null, invitePage);
	const account = await Invites.accept(Auth.config().db(), token, user).catch((err: unknown) => {
		if (err instanceof ServiceError) redirect(303, `${invitePage}&error=${err.status}`);
		throw err;
	});
	redirect(303, Auth.config().accountHome(account.slug));
}

const handlers: Record<string, (event: RequestEvent) => Promise<Response>> = {
	email: emailLink,
	'invite/accept': invite,
	logout,
	'passkey/delete': passkeyDelete,
	'passkey/login': passkeyLogin,
	'passkey/login-options': async (event) =>
		json(Passkeys.authenticationOptions(relyingParty(event), setChallenge(event))),
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
