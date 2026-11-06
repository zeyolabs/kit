import type { RequestEvent } from '@sveltejs/kit';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthDb } from '../config';

import { FakeEmailClient } from '../../cloudflare/email/testing';
import { createTestDb } from '../__fixtures__/db';
import { configureAuth } from '../config';
import { findOrCreateUser } from '../users';
import { addMember, createAccount } from './accounts';
import { createAccountHandle, requirePermission, slugFromRoute } from './handle';

let db: AuthDb;

beforeEach(async () => {
	db = await createTestDb();
	configureAuth({
		accounts: {
			memberPermissions: ['projects.read'],
			permissions: ['projects.read', 'projects.edit'],
		},
		appName: 'Example',
		db: () => db,
		email: () => new FakeEmailClient(),
		emailBrand: {
			accent: '#000',
			accentDark: '#000',
			accentSoft: '#eee',
			name: 'Example',
			supportEmail: 'x@example.com',
		},
		isAllowed: () => true,
	});
});

function event(
	path: string,
	init: { params?: Record<string, string>; referer?: string; user?: unknown } = {}
) {
	const url = new URL(path, 'https://app.example.com');
	return {
		locals: { user: init.user ?? null },
		params: init.params ?? {},
		request: new Request(url, { headers: init.referer ? { referer: init.referer } : {} }),
		url,
	} as unknown as RequestEvent;
}

describe('slugFromRoute', () => {
	const slug = slugFromRoute();
	it('reads the route param, or the calling page for remote calls', () => {
		expect(slug(event('/acme/x', { params: { account: 'acme' } }))).toBe('acme');
		expect(slug(event('/_app/remote/abc/q', { referer: 'https://app.example.com/acme/p' }))).toBe(
			'acme'
		);
		expect(slug(event('/_app/remote/abc/q', { referer: 'https://evil.com/acme' }))).toBeNull();
		expect(slug(event('/settings'))).toBeNull();
	});
});

describe('createAccountHandle', () => {
	it('sets the membership for members and 404s for anyone else', async () => {
		const ada = await findOrCreateUser(db, 'ada@example.com');
		const eve = await findOrCreateUser(db, 'eve@example.com');
		const { id } = await createAccount(db, { name: 'Acme', slug: 'acme' });
		await addMember(db, id, ada.id, 'member');
		const handle = createAccountHandle({ slug: () => 'acme' });
		const resolve = vi.fn(async () => new Response('ok'));

		const asAda = event('/acme', { user: ada });
		await handle({ event: asAda, resolve });
		expect(requirePermission(asAda, 'projects.read').userId).toBe(ada.id);
		expect(() => requirePermission(asAda, 'projects.edit')).toThrow('permission');

		await expect(handle({ event: event('/acme', { user: eve }), resolve })).rejects.toMatchObject({
			status: 404,
		});
		const missing = createAccountHandle({ slug: () => 'nope' });
		await expect(missing({ event: event('/nope', { user: ada }), resolve })).rejects.toMatchObject({
			status: 404,
		});
	});
});
