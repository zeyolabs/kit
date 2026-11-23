import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthDb } from '../config';
import type { Membership } from './accounts';

import { createTestDb } from '../__fixtures__/db';
import { SignInService } from '../sign-in';
import { AccountService } from './accounts';

const catalogue = {
	memberPermissions: ['projects.read'],
	permissions: ['projects.read', 'projects.edit'],
};
const NOW = 1_800_000_000_000;

let db: AuthDb;
let accounts: AccountService;
let signIn: SignInService;
let accountId: number;
let ownerId: number;
let bobId: number;

const member = async (userId: number) =>
	(await accounts.resolveMembership(accountId, userId)) as Membership;

beforeEach(async () => {
	db = await createTestDb();
	accounts = new AccountService(db, catalogue);
	signIn = new SignInService(db);
	ownerId = (await signIn.findOrCreateUser('ada@example.com')).id;
	bobId = (await signIn.findOrCreateUser('bob@example.com')).id;
	accountId = (await accounts.create({ name: 'Acme', slug: 'acme' }, ownerId, NOW)).id;
	await accounts.addMember(accountId, bobId, 'member', NOW);
});

describe('accounts and memberships', () => {
	it('makes the creator owner and resolves policies', async () => {
		expect((await member(ownerId)).policy.key).toBe('owner');
		expect((await member(bobId)).policy.permissions).toEqual(['projects.read']);
		expect(await accounts.listForUser(bobId)).toMatchObject([{ policy: 'member', slug: 'acme' }]);
	});

	it('rejects taken and malformed slugs', async () => {
		await expect(accounts.create({ name: 'X', slug: 'acme' })).rejects.toThrow('taken');
		await expect(accounts.create({ name: 'X', slug: 'Bad Slug' })).rejects.toThrow();
	});

	it('only lets members with members.read list members', async () => {
		await expect(accounts.listMembers(await member(bobId))).rejects.toThrow('permission');
		expect(await accounts.listMembers(await member(ownerId))).toHaveLength(2);
	});
});

describe('the last owner', () => {
	it('cannot be demoted or removed, but can once there is another owner', async () => {
		const owner = await member(ownerId);
		await expect(accounts.removeMember(owner, ownerId)).rejects.toThrow('at least one owner');
		await accounts.setMemberPolicy(owner, bobId, 'owner');
		await accounts.removeMember(owner, ownerId);
		expect(await accounts.resolveMembership(accountId, ownerId)).toBeNull();
	});

	it('only owners confer ownership, and nobody changes their own policy', async () => {
		await accounts.setMemberPolicy(await member(ownerId), bobId, 'admin');
		const admin = await member(bobId);
		const carol = (await signIn.findOrCreateUser('carol@example.com')).id;
		await accounts.addMember(accountId, carol, 'member');
		await expect(accounts.setMemberPolicy(admin, carol, 'owner')).rejects.toThrow('owner');
		await expect(accounts.setMemberPolicy(admin, ownerId, 'member')).rejects.toThrow('owner');
		await expect(accounts.setMemberPolicy(admin, bobId, 'member')).rejects.toThrow('own');
		await accounts.setMemberPolicy(admin, carol, 'admin');
	});
});

describe('custom policies', () => {
	it('are saved from catalogue keys, assigned, and protected while in use', async () => {
		const owner = await member(ownerId);
		await accounts.savePolicy(owner, {
			key: 'editor',
			name: 'Editor',
			permissions: ['projects.*', 'members.read'],
		});
		await accounts.setMemberPolicy(owner, bobId, 'editor');
		const editor = await member(bobId);
		expect(editor.policy.name).toBe('Editor');
		expect(await accounts.listMembers(editor)).toHaveLength(2);
		await expect(accounts.deletePolicy(owner, 'editor')).rejects.toThrow('Move its members');
		await expect(
			accounts.savePolicy(owner, { key: 'x', name: 'X', permissions: ['*'] })
		).rejects.toThrow('Unknown permissions');
		await expect(
			accounts.savePolicy(editor, { key: 'y', name: 'Y', permissions: [] })
		).rejects.toThrow('permission');
	});
});

describe('invites', () => {
	it('are accepted once, by the invited email only', async () => {
		const owner = await member(ownerId);
		const token = await accounts.createInvite(
			owner,
			{ email: 'Carol@Example.com', policy: 'member' },
			NOW
		);
		expect(await accounts.findInvite(token, NOW)).toMatchObject({
			account: { slug: 'acme' },
			email: 'carol@example.com',
		});
		expect(await accounts.hasAccess('carol@example.com', NOW)).toBe(true);

		const eve = await signIn.findOrCreateUser('eve@example.com');
		await expect(accounts.acceptInvite(token, eve, NOW)).rejects.toThrow('carol@example.com');

		const carol = await signIn.findOrCreateUser('carol@example.com');
		expect(await accounts.acceptInvite(token, carol, NOW)).toMatchObject({ slug: 'acme' });
		expect((await accounts.resolveMembership(accountId, carol.id))?.policy.key).toBe('member');
		await expect(accounts.acceptInvite(token, carol, NOW)).rejects.toThrow(
			'expired or was already used'
		);
	});

	it('expire, and only owners invite owners', async () => {
		const owner = await member(ownerId);
		const token = await accounts.createInvite(
			owner,
			{ email: 'c@example.com', policy: 'member' },
			NOW
		);
		expect(await accounts.findInvite(token, NOW + 8 * 24 * 60 * 60 * 1000)).toBeNull();
		await accounts.setMemberPolicy(owner, bobId, 'admin');
		await expect(
			accounts.createInvite(await member(bobId), {
				email: 'd@example.com',
				policy: 'owner',
			})
		).rejects.toThrow('owner');
		expect(await accounts.hasAccess('nobody@example.com', NOW)).toBe(false);
	});
});

describe('ensureOwner', () => {
	it('creates the account on first use and makes the user its owner', async () => {
		const carolId = (await signIn.findOrCreateUser('carol@example.com')).id;
		const account = await accounts.ensureOwner({ name: 'Shop', slug: 'shop' }, carolId, NOW);
		expect(account).toMatchObject({ name: 'Shop', slug: 'shop' });
		const membership = await accounts.resolveMembership(account.id, carolId);
		expect(membership?.policy.key).toBe('owner');
	});

	it('reuses the account and is safe to repeat', async () => {
		const again = await accounts.ensureOwner({ name: 'Acme', slug: 'acme' }, ownerId, NOW);
		expect(again.id).toBe(accountId);
		await accounts.ensureOwner({ name: 'Acme', slug: 'acme' }, ownerId, NOW);
		expect(await accounts.listMembers(await member(ownerId))).toHaveLength(2);
	});

	it('does not demote an existing member', async () => {
		await accounts.ensureOwner({ name: 'Acme', slug: 'acme' }, bobId, NOW);
		expect((await member(bobId)).policy.key).toBe('member');
	});

	it('survives two requests creating the same account at once', async () => {
		const aId = (await signIn.findOrCreateUser('a@example.com')).id;
		const bId = (await signIn.findOrCreateUser('b@example.com')).id;
		const [a, b] = await Promise.all([
			accounts.ensureOwner({ name: 'New', slug: 'new-shop' }, aId, NOW),
			accounts.ensureOwner({ name: 'New', slug: 'new-shop' }, bId, NOW),
		]);
		expect(a.id).toBe(b.id);
	});
});
