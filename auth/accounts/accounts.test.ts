import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthDb } from '../config';
import type { Membership } from './accounts';

import { createTestDb } from '../__fixtures__/db';
import { Users } from '../users';
import { Accounts } from './accounts';
import { Invites } from './invites';

const catalogue = {
	memberPermissions: ['projects.read'],
	permissions: ['projects.read', 'projects.edit'],
};
const NOW = 1_800_000_000_000;

let db: AuthDb;
let accountId: number;
let ownerId: number;
let bobId: number;

const member = async (userId: number) =>
	(await Accounts.resolveMembership(db, catalogue, accountId, userId)) as Membership;

beforeEach(async () => {
	db = await createTestDb();
	ownerId = (await Users.findOrCreate(db, 'ada@example.com')).id;
	bobId = (await Users.findOrCreate(db, 'bob@example.com')).id;
	accountId = (await Accounts.create(db, { name: 'Acme', slug: 'acme' }, ownerId, NOW)).id;
	await Accounts.addMember(db, accountId, bobId, 'member', NOW);
});

describe('accounts and memberships', () => {
	it('makes the creator owner and resolves policies', async () => {
		expect((await member(ownerId)).policy.key).toBe('owner');
		expect((await member(bobId)).policy.permissions).toEqual(['projects.read']);
		expect(await Accounts.listForUser(db, bobId)).toMatchObject([
			{ policy: 'member', slug: 'acme' },
		]);
	});

	it('rejects taken and malformed slugs', async () => {
		await expect(Accounts.create(db, { name: 'X', slug: 'acme' })).rejects.toThrow('taken');
		await expect(Accounts.create(db, { name: 'X', slug: 'Bad Slug' })).rejects.toThrow();
	});

	it('only lets members with members.read list members', async () => {
		await expect(Accounts.listMembers(db, await member(bobId))).rejects.toThrow('permission');
		expect(await Accounts.listMembers(db, await member(ownerId))).toHaveLength(2);
	});
});

describe('the last owner', () => {
	it('cannot be demoted or removed, but can once there is another owner', async () => {
		const owner = await member(ownerId);
		await expect(Accounts.removeMember(db, owner, ownerId)).rejects.toThrow('at least one owner');
		await Accounts.setMemberPolicy(db, catalogue, owner, bobId, 'owner');
		await Accounts.removeMember(db, owner, ownerId);
		expect(await Accounts.resolveMembership(db, catalogue, accountId, ownerId)).toBeNull();
	});

	it('only owners confer ownership, and nobody changes their own policy', async () => {
		await Accounts.setMemberPolicy(db, catalogue, await member(ownerId), bobId, 'admin');
		const admin = await member(bobId);
		const carol = (await Users.findOrCreate(db, 'carol@example.com')).id;
		await Accounts.addMember(db, accountId, carol, 'member');
		await expect(Accounts.setMemberPolicy(db, catalogue, admin, carol, 'owner')).rejects.toThrow(
			'owner'
		);
		await expect(Accounts.setMemberPolicy(db, catalogue, admin, ownerId, 'member')).rejects.toThrow(
			'owner'
		);
		await expect(Accounts.setMemberPolicy(db, catalogue, admin, bobId, 'member')).rejects.toThrow(
			'own'
		);
		await Accounts.setMemberPolicy(db, catalogue, admin, carol, 'admin');
	});
});

describe('custom policies', () => {
	it('are saved from catalogue keys, assigned, and protected while in use', async () => {
		const owner = await member(ownerId);
		await Accounts.savePolicy(db, catalogue, owner, {
			key: 'editor',
			name: 'Editor',
			permissions: ['projects.*', 'members.read'],
		});
		await Accounts.setMemberPolicy(db, catalogue, owner, bobId, 'editor');
		const editor = await member(bobId);
		expect(editor.policy.name).toBe('Editor');
		expect(await Accounts.listMembers(db, editor)).toHaveLength(2);
		await expect(Accounts.deletePolicy(db, owner, 'editor')).rejects.toThrow('Move its members');
		await expect(
			Accounts.savePolicy(db, catalogue, owner, { key: 'x', name: 'X', permissions: ['*'] })
		).rejects.toThrow('Unknown permissions');
		await expect(
			Accounts.savePolicy(db, catalogue, editor, { key: 'y', name: 'Y', permissions: [] })
		).rejects.toThrow('permission');
	});
});

describe('invites', () => {
	it('are accepted once, by the invited email only', async () => {
		const owner = await member(ownerId);
		const token = await Invites.create(
			db,
			catalogue,
			owner,
			{ email: 'Carol@Example.com', policy: 'member' },
			NOW
		);
		expect(await Invites.find(db, token, NOW)).toMatchObject({
			account: { slug: 'acme' },
			email: 'carol@example.com',
		});
		expect(await Accounts.hasAccess(db, 'carol@example.com', NOW)).toBe(true);

		const eve = await Users.findOrCreate(db, 'eve@example.com');
		await expect(Invites.accept(db, token, eve, NOW)).rejects.toThrow('carol@example.com');

		const carol = await Users.findOrCreate(db, 'carol@example.com');
		expect(await Invites.accept(db, token, carol, NOW)).toMatchObject({ slug: 'acme' });
		expect((await Accounts.resolveMembership(db, catalogue, accountId, carol.id))?.policy.key).toBe(
			'member'
		);
		await expect(Invites.accept(db, token, carol, NOW)).rejects.toThrow(
			'expired or was already used'
		);
	});

	it('expire, and only owners invite owners', async () => {
		const owner = await member(ownerId);
		const token = await Invites.create(
			db,
			catalogue,
			owner,
			{ email: 'c@example.com', policy: 'member' },
			NOW
		);
		expect(await Invites.find(db, token, NOW + 8 * 24 * 60 * 60 * 1000)).toBeNull();
		await Accounts.setMemberPolicy(db, catalogue, owner, bobId, 'admin');
		await expect(
			Invites.create(db, catalogue, await member(bobId), {
				email: 'd@example.com',
				policy: 'owner',
			})
		).rejects.toThrow('owner');
		expect(await Accounts.hasAccess(db, 'nobody@example.com', NOW)).toBe(false);
	});
});

describe('ensureOwner', () => {
	it('creates the account on first use and makes the user its owner', async () => {
		const carolId = (await Users.findOrCreate(db, 'carol@example.com')).id;
		const account = await Accounts.ensureOwner(db, { name: 'Shop', slug: 'shop' }, carolId, NOW);
		expect(account).toMatchObject({ name: 'Shop', slug: 'shop' });
		const membership = await Accounts.resolveMembership(db, catalogue, account.id, carolId);
		expect(membership?.policy.key).toBe('owner');
	});

	it('reuses the account and is safe to repeat', async () => {
		const again = await Accounts.ensureOwner(db, { name: 'Acme', slug: 'acme' }, ownerId, NOW);
		expect(again.id).toBe(accountId);
		await Accounts.ensureOwner(db, { name: 'Acme', slug: 'acme' }, ownerId, NOW);
		expect(await Accounts.listMembers(db, await member(ownerId))).toHaveLength(2);
	});

	it('does not demote an existing member', async () => {
		await Accounts.ensureOwner(db, { name: 'Acme', slug: 'acme' }, bobId, NOW);
		expect((await member(bobId)).policy.key).toBe('member');
	});

	it('survives two requests creating the same account at once', async () => {
		const aId = (await Users.findOrCreate(db, 'a@example.com')).id;
		const bId = (await Users.findOrCreate(db, 'b@example.com')).id;
		const [a, b] = await Promise.all([
			Accounts.ensureOwner(db, { name: 'New', slug: 'new-shop' }, aId, NOW),
			Accounts.ensureOwner(db, { name: 'New', slug: 'new-shop' }, bId, NOW),
		]);
		expect(a.id).toBe(b.id);
	});
});
