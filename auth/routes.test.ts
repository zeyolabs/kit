import type { RequestEvent } from '@sveltejs/kit';

import { isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthDb, MagicLinkMessage } from './config';

import { TestAuthenticator } from './__fixtures__/authenticator';
import { createTestDb } from './__fixtures__/db';
import { configureAuth } from './config';
import { createAuthHandle } from './handle';
import { POST, safeNext } from './routes';
import { createSession } from './sessions';
import { findOrCreateUser } from './users';

const ORIGIN = 'https://app.example.com';

let db: AuthDb;
let sent: MagicLinkMessage[];
let jar: Map<string, string>;

beforeEach(async () => {
	db = await createTestDb();
	sent = [];
	jar = new Map();
	configureAuth({
		appName: 'Example',
		db: () => db,
		isAllowed: (email) => email.endsWith('@example.com'),
		sendMagicLink: async (message) => void sent.push(message),
	});
});

function event(
	path: string,
	init: { body?: unknown; form?: Record<string, string>; method?: string; origin?: string } = {}
): RequestEvent {
	const url = new URL(path, ORIGIN);
	const headers = new Headers({ origin: init.origin ?? ORIGIN });
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
		return await createAuthHandle()({ event: e, resolve: () => POST(e as never) });
	} catch (err) {
		if (isRedirect(err)) return err.location;
		throw err;
	}
}

describe('safeNext', () => {
	it('keeps same-site paths only', () => {
		expect(safeNext('/orders?x=1')).toBe('/orders?x=1');
		for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '', null]) {
			expect(safeNext(bad)).toBe('/');
		}
	});
});

describe('magic link flow', () => {
	it('emails a link that signs in once', async () => {
		const location = await call(
			event('/auth/email', { form: { email: 'Ada@Example.com', next: '/orders' } })
		);
		expect(location).toBe('/login?sent=1&next=%2Forders');
		expect(sent).toHaveLength(1);
		const link = new URL(sent[0].url);
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
		expect(sent).toHaveLength(0);
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
		const handle = createAuthHandle();
		const resolve = vi.fn();
		await expect(handle({ event: event('/orders?page=2'), resolve })).rejects.toMatchObject({
			location: '/login?next=%2Forders%3Fpage%3D2',
		});
		const api = await handle({ event: event('/_app/remote/abc/list'), resolve });
		expect((api as Response).status).toBe(401);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('signs out a user who is no longer allowed', async () => {
		const user = await findOrCreateUser(db, 'ada@example.com');
		jar.set('session', (await createSession(db, user.id)).token);
		const resolve = vi.fn(async () => new Response('ok'));
		await createAuthHandle()({ event: event('/'), resolve });
		expect(resolve).toHaveBeenCalledOnce();

		configureAuth({
			appName: 'Example',
			db: () => db,
			isAllowed: () => false,
			sendMagicLink: async () => {},
		});
		await expect(createAuthHandle()({ event: event('/'), resolve })).rejects.toMatchObject({
			status: 303,
		});
		expect(jar.has('session')).toBe(false);
	});
});

describe('passkey flow', () => {
	async function signedIn(ageMs = 0) {
		const user = await findOrCreateUser(db, 'ada@example.com');
		jar.set('session', (await createSession(db, user.id, Date.now() - ageMs)).token);
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
