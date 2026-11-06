import type { RequestEvent } from '@sveltejs/kit';

import { isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthDb } from '../config';

import { FakeEmailClient } from '../../cloudflare/email/testing';
import { TestAuthenticator } from '../__fixtures__/authenticator';
import { createTestDb } from '../__fixtures__/db';
import { Accounts } from '../accounts/accounts';
import { Invites } from '../accounts/invites';
import { Auth } from '../config';
import { AuthHandle } from '../sessions/handle';
import { Sessions } from '../sessions/sessions';
import { Users } from '../users';
import { Login } from './login';
import { POST } from './routes';

const ORIGIN = 'https://app.example.com';
const CATALOGUE = { memberPermissions: [], permissions: [] };
const BRAND = {
	accent: '#000000',
	accentDark: '#000000',
	accentSoft: '#eeeeee',
	name: 'Example',
	supportEmail: 'help@example.com',
};
const sentLink = (i = 0) =>
	new URL(/https:\/\/\S+?token=[0-9a-f]+[^\s"]*/.exec(mail.sent[i].text!)![0]);

let db: AuthDb;
let mail: FakeEmailClient;
let jar: Map<string, string>;

beforeEach(async () => {
	db = await createTestDb();
	mail = new FakeEmailClient();
	jar = new Map();
	Auth.configure({
		accounts: CATALOGUE,
		appName: 'Example',
		db: () => db,
		email: () => mail,
		emailBrand: BRAND,
		isAllowed: (email) => email.endsWith('@example.com'),
	});
});

function event(
	path: string,
	init: { body?: unknown; form?: Record<string, string>; method?: string; origin?: string } = {}
): RequestEvent {
	const url = new URL(path, ORIGIN);
	const headers = new Headers({ accept: 'text/html', origin: init.origin ?? ORIGIN });
	let body: BodyInit | undefined;
	if (init.form) body = new URLSearchParams(init.form);
	if (init.body) {
		body = JSON.stringify(init.body);
		headers.set('content-type', 'application/json');
	}
	const method = init.method ?? (body ? 'POST' : 'GET');
	return {
		cookies: {
			delete: (name: string) => void jar.delete(name),
			get: (name: string) => jar.get(name),
			set: (name: string, value: string) => void jar.set(name, value),
		},
		locals: {},
		params: { path: url.pathname.replace(/^\/auth\//, '') },
		request: new Request(url, { body, headers, method }),
		url,
	} as unknown as RequestEvent;
}

/** Runs the auth handle (so locals are set), then the route; returns the redirect location or
 *  the response. */
async function call(e: RequestEvent): Promise<Response | string> {
	try {
		return await AuthHandle.create()({ event: e, resolve: () => POST(e as never) });
	} catch (err) {
		if (isRedirect(err)) return err.location;
		throw err;
	}
}

describe('Login.safeNext', () => {
	it('keeps same-site paths only', () => {
		expect(Login.safeNext('/orders?x=1')).toBe('/orders?x=1');
		for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '', null]) {
			expect(Login.safeNext(bad)).toBe('/');
		}
	});
});

describe('magic link flow', () => {
	it('emails a link that signs in once', async () => {
		const location = await call(
			event('/auth/email', { form: { email: 'Ada@Example.com', next: '/orders' } })
		);
		expect(location).toBe('/login?sent=1&next=%2Forders');
		expect(mail.sent).toHaveLength(1);
		expect(mail.sent[0]).toMatchObject({ subject: 'Sign in to Example', to: 'ada@example.com' });
		const link = sentLink();
		expect(link.origin + link.pathname).toBe(`${ORIGIN}/login`);
		const token = link.searchParams.get('token')!;

		expect(await call(event('/auth/verify', { form: { next: '/orders', token } }))).toBe('/orders');
		expect(jar.get('session')).toMatch(/^[0-9a-f]+\.[0-9a-f]+$/);

		jar.clear();
		expect(await call(event('/auth/verify', { form: { token } }))).toBe('/login?error=expired');
		expect(jar.has('session')).toBe(false);
	});

	it('answers an unknown email the same way without sending anything', async () => {
		const location = await call(event('/auth/email', { form: { email: 'eve@evil.com' } }));
		expect(location).toBe('/login?sent=1');
		expect(mail.sent).toHaveLength(0);
	});

	it('refuses cross-site posts', async () => {
		const response = await call(
			event('/auth/email', { form: { email: 'ada@example.com' }, origin: 'https://evil.com' })
		);
		expect((response as Response).status).toBe(403);
	});
});

describe('the handle', () => {
	it('redirects pages to login with next, and 401s API calls', async () => {
		const handle = AuthHandle.create();
		const resolve = vi.fn();
		await expect(handle({ event: event('/orders?page=2'), resolve })).rejects.toMatchObject({
			location: '/login?next=%2Forders%3Fpage%3D2',
		});
		const api = await handle({ event: event('/_app/remote/abc/list'), resolve });
		expect((api as Response).status).toBe(401);
		const socket = event('/realtime/topic');
		socket.request.headers.delete('accept');
		expect(((await handle({ event: socket, resolve })) as Response).status).toBe(401);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('signs out a user who is no longer allowed', async () => {
		const user = await Users.findOrCreate(db, 'ada@example.com');
		jar.set('session', (await Sessions.create(db, user.id)).token);
		const resolve = vi.fn(async () => new Response('ok'));
		await AuthHandle.create()({ event: event('/'), resolve });
		expect(resolve).toHaveBeenCalledOnce();

		Auth.configure({
			accounts: CATALOGUE,
			appName: 'Example',
			db: () => db,
			email: () => mail,
			emailBrand: BRAND,
			isAllowed: () => false,
		});
		await expect(AuthHandle.create()({ event: event('/'), resolve })).rejects.toMatchObject({
			status: 303,
		});
		expect(jar.has('session')).toBe(false);
	});
});

describe('passkey flow', () => {
	async function signedIn(ageMs = 0) {
		const user = await Users.findOrCreate(db, 'ada@example.com');
		jar.set('session', (await Sessions.create(db, user.id, Date.now() - ageMs)).token);
	}

	async function json(e: RequestEvent) {
		const response = (await call(e)) as Response;
		return { body: await response.json(), status: response.status };
	}

	it('adds a passkey to a fresh session, then signs in with it', async () => {
		await signedIn();
		const authenticator = await TestAuthenticator.create();
		const rp = { id: 'app.example.com', name: 'Example', origin: ORIGIN };

		const options = await json(event('/auth/passkey/register-options', { body: {} }));
		expect(options.status).toBe(200);
		const credential = await authenticator.register(options.body.challenge, rp);
		const saved = await json(
			event('/auth/passkey/register', { body: { credential, name: 'Mac' } })
		);
		expect(saved).toEqual({ body: { ok: true }, status: 200 });

		jar.clear();
		const login = await json(event('/auth/passkey/login-options', { body: {} }));
		const assertion = await authenticator.signIn(login.body.challenge, rp);
		const result = await json(
			event('/auth/passkey/login', { body: { credential: assertion, next: '/x' } })
		);
		expect(result).toEqual({ body: { redirect: '/x' }, status: 200 });
		expect(jar.has('session')).toBe(true);

		// The challenge was used up: replaying the same assertion fails.
		const replay = await json(event('/auth/passkey/login', { body: { credential: assertion } }));
		expect(replay.status).toBe(400);
	});

	it('asks for a fresh sign-in before adding a passkey to an old session', async () => {
		await signedIn(60 * 60 * 1000);
		const options = await json(event('/auth/passkey/register-options', { body: {} }));
		expect(options).toMatchObject({ body: { reauth: true }, status: 403 });
	});
});

describe('invite flow', () => {
	it('sends a signed-out invitee to log in, then joins them to the account', async () => {
		const owner = await Users.findOrCreate(db, 'ada@example.com');
		const account = await Accounts.create(db, { name: 'Acme', slug: 'acme' }, owner.id);
		const ownerMembership = await Accounts.resolveMembership(db, CATALOGUE, account.id, owner.id);
		const token = await Invites.create(db, CATALOGUE, ownerMembership!, {
			email: 'carol@example.com',
			policy: 'member',
		});

		const signedOut = await call(event('/auth/invite/accept', { form: { token } }));
		expect(signedOut).toBe(`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`);

		const carol = await Users.findOrCreate(db, 'carol@example.com');
		jar.set('session', (await Sessions.create(db, carol.id)).token);
		expect(await call(event('/auth/invite/accept', { form: { token } }))).toBe('/acme');
		expect(
			(await Accounts.resolveMembership(db, CATALOGUE, account.id, carol.id))?.policy.key
		).toBe('member');

		// Used up: a second accept goes back to the invite page with the error.
		expect(await call(event('/auth/invite/accept', { form: { token } }))).toMatch(/error=404$/);
	});
});
