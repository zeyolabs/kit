import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthDb } from './config';

import { FakeTurnstileClient } from '../cloudflare/turnstile/testing';
import { FakeMailClient } from '../email/testing';
import { createTestDb } from './__fixtures__/db';
import { Auth } from './config';
import { SignInService } from './sign-in';

let db: AuthDb;
let signIn: SignInService;
let userId: number;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
	db = await createTestDb();
	signIn = new SignInService(db);
	userId = (await signIn.findOrCreateUser('ada@example.com')).id;
});

describe('SignInService.splitToken', () => {
	it('splits id.secret and rejects anything else', () => {
		expect(SignInService.splitToken('a.b')).toEqual({ id: 'a', secret: 'b' });
		expect(SignInService.splitToken('a')).toBeNull();
		expect(SignInService.splitToken('a.b.c')).toBeNull();
		expect(SignInService.splitToken('.b')).toBeNull();
	});
});

describe('sessions', () => {
	it('validates a fresh session and returns its user', async () => {
		const { token } = await signIn.createSession(userId, NOW);
		const live = await signIn.validateSession(token, NOW + 1000);
		expect(live?.user).toMatchObject({ email: 'ada@example.com', id: userId });
		expect(live?.session.expiresAt).toBe(NOW + SignInService.SESSION_LIFETIME_MS);
	});

	it('rejects a forged secret', async () => {
		const { id } = await signIn.createSession(userId, NOW);
		expect(await signIn.validateSession(`${id}.${'0'.repeat(64)}`, NOW)).toBeNull();
	});

	it('rejects an expired session', async () => {
		const { token } = await signIn.createSession(userId, NOW);
		expect(await signIn.validateSession(token, NOW + SignInService.SESSION_LIFETIME_MS)).toBeNull();
	});

	it('renews and deletes', async () => {
		const { id, token } = await signIn.createSession(userId, NOW);
		const later = NOW + SignInService.SESSION_LIFETIME_MS - 1000;
		expect(await signIn.renewSession(id, later)).toBe(later + SignInService.SESSION_LIFETIME_MS);
		expect(
			await signIn.validateSession(token, NOW + SignInService.SESSION_LIFETIME_MS + 1)
		).not.toBeNull();
		await signIn.deleteSession(id);
		expect(await signIn.validateSession(token, NOW)).toBeNull();
	});
});

describe('SignInService.needsRenewal', () => {
	it('renews only in the second half of the lifetime', () => {
		expect(SignInService.needsRenewal(NOW + SignInService.SESSION_LIFETIME_MS, NOW)).toBe(false);
		expect(SignInService.needsRenewal(NOW + SignInService.SESSION_RENEW_BELOW_MS - 1, NOW)).toBe(
			true
		);
	});
});

describe('magic links', () => {
	it('works exactly once', async () => {
		const token = await signIn.issueLink('ada@example.com', NOW);
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(await signIn.consumeLink(token!, NOW + 1000)).toBe('ada@example.com');
		expect(await signIn.consumeLink(token!, NOW + 2000)).toBeNull();
	});

	it('expires', async () => {
		const token = await signIn.issueLink('ada@example.com', NOW);
		expect(await signIn.consumeLink(token!, NOW + SignInService.LINK_TTL_MS)).toBeNull();
	});

	it('rejects unknown and malformed tokens', async () => {
		expect(await signIn.consumeLink('f'.repeat(64), NOW)).toBeNull();
		expect(await signIn.consumeLink('not-a-token', NOW)).toBeNull();
	});

	it('caps live links per email, and frees the cap once they expire', async () => {
		for (let i = 0; i < SignInService.MAX_LIVE_LINKS; i++) {
			expect(await signIn.issueLink('ada@example.com', NOW)).not.toBeNull();
		}
		expect(await signIn.issueLink('ada@example.com', NOW)).toBeNull();
		expect(await signIn.issueLink('bob@example.com', NOW)).not.toBeNull();
		expect(
			await signIn.issueLink('ada@example.com', NOW + SignInService.LINK_TTL_MS + 1)
		).not.toBeNull();
	});
});

describe('users', () => {
	it('creates a user once per email, case-insensitively', async () => {
		const first = await signIn.findOrCreateUser('Ada@Example.com');
		const again = await signIn.findOrCreateUser('ada@example.com');
		expect(again.id).toBe(first.id);
		expect(first).toMatchObject({ email: 'ada@example.com', name: 'ada' });
	});
});

describe('requesting a sign-in link', () => {
	let mail: FakeMailClient;

	beforeEach(() => {
		mail = new FakeMailClient();
		Auth.configure({
			accounts: { memberPermissions: [], permissions: [] },
			appName: 'Example',
			db: () => db,
			email: () => mail,
			emailBrand: {
				accent: '#000000',
				accentDark: '#000000',
				accentSoft: '#eeeeee',
				name: 'Example',
				supportEmail: 'help@example.com',
			},
			emailFrom: 'noreply@example.com',
			isAllowed: (email) => email.endsWith('@example.com'),
		});
	});

	const request = (over: Partial<Parameters<SignInService['requestLink']>[0]> = {}) => ({
		accessEmail: null,
		email: 'ada@example.com',
		hostname: 'app.example.com',
		ip: '203.0.113.7',
		next: '/',
		origin: 'https://app.example.com',
		turnstileToken: 'tok',
		...over,
	});

	it('emails a link without Turnstile', async () => {
		expect(await signIn.requestLink(request())).toEqual({ error: null, sent: true });
		expect(mail.sent).toHaveLength(1);
	});

	it('asks Turnstile first, with the host, address and token', async () => {
		const turnstile = new FakeTurnstileClient();
		await new SignInService(db, turnstile).requestLink(request());
		expect(turnstile.checks).toEqual([
			{ hostname: 'app.example.com', ip: '203.0.113.7', token: 'tok' },
		]);
		expect(mail.sent).toHaveLength(1);
	});

	it('stops at a failed bot check before any email', async () => {
		const service = new SignInService(db, new FakeTurnstileClient(false));
		expect(await service.requestLink(request())).toEqual({ error: 'bot', sent: false });
		expect(mail.sent).toHaveLength(0);
	});

	it('answers an unknown email like a known one, without sending', async () => {
		expect(await signIn.requestLink(request({ email: 'eve@evil.com' }))).toEqual({
			error: null,
			sent: true,
		});
		expect(mail.sent).toHaveLength(0);
	});

	it('refuses a different email than the Access identity, and a bad address', async () => {
		expect(await signIn.requestLink(request({ accessEmail: 'bob@example.com' }))).toEqual({
			error: 'mismatch',
			sent: false,
		});
		expect(await signIn.requestLink(request({ email: 'nope' }))).toEqual({
			error: 'send',
			sent: false,
		});
	});
});
