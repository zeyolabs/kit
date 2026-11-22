import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthDb } from './config';

import { FakeEmailClient } from '../cloudflare/email/testing';
import { FakeTurnstileClient } from '../cloudflare/turnstile/testing';
import { createTestDb } from './__fixtures__/db';
import { Auth } from './config';
import { EmailLinkService } from './email-link';

const CATALOGUE = { memberPermissions: [], permissions: [] };
const BRAND = {
	accent: '#000000',
	accentDark: '#000000',
	accentSoft: '#eeeeee',
	name: 'Example',
	supportEmail: 'help@example.com',
};

let db: AuthDb;
let mail: FakeEmailClient;

beforeEach(async () => {
	db = await createTestDb();
	mail = new FakeEmailClient();
	Auth.configure({
		accounts: CATALOGUE,
		appName: 'Example',
		db: () => db,
		email: () => mail,
		emailBrand: BRAND,
		isAllowed: (email) => email.endsWith('@example.com'),
	});
});

const request = (over: Partial<Parameters<EmailLinkService['request']>[0]> = {}) => ({
	accessEmail: null,
	email: 'ada@example.com',
	hostname: 'app.example.com',
	ip: '203.0.113.7',
	next: '/',
	origin: 'https://app.example.com',
	turnstileToken: 'tok',
	...over,
});

describe('EmailLinkService', () => {
	it('emails a link without Turnstile', async () => {
		const result = await new EmailLinkService(db, null).request(request());
		expect(result).toEqual({ error: null, sent: true });
		expect(mail.sent).toHaveLength(1);
	});

	it('asks Turnstile first, with the host, address and token', async () => {
		const turnstile = new FakeTurnstileClient();
		await new EmailLinkService(db, turnstile).request(request());
		expect(turnstile.checks).toEqual([
			{ hostname: 'app.example.com', ip: '203.0.113.7', token: 'tok' },
		]);
		expect(mail.sent).toHaveLength(1);
	});

	it('stops at a failed bot check before any email', async () => {
		const result = await new EmailLinkService(db, new FakeTurnstileClient(false)).request(
			request()
		);
		expect(result).toEqual({ error: 'bot', sent: false });
		expect(mail.sent).toHaveLength(0);
	});

	it('answers an unknown email like a known one, without sending', async () => {
		const result = await new EmailLinkService(db, null).request(request({ email: 'eve@evil.com' }));
		expect(result).toEqual({ error: null, sent: true });
		expect(mail.sent).toHaveLength(0);
	});

	it('refuses a different email than the Access identity, and a bad address', async () => {
		const service = new EmailLinkService(db, null);
		expect(await service.request(request({ accessEmail: 'bob@example.com' }))).toEqual({
			error: 'mismatch',
			sent: false,
		});
		expect(await service.request(request({ email: 'nope' }))).toEqual({
			error: 'send',
			sent: false,
		});
	});
});
