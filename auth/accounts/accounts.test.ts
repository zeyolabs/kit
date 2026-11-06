import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthDb } from '../config';

import { createTestDb } from '../__fixtures__/db';
import { findOrCreateUser } from '../users';
import {
	acceptInvite,
	addMember,
	createAccount,
	createInvite,
	deletePolicy,
	findInvite,
	hasAccountAccess,
	listAccountsForUser,
	listMembers,
	type Membership,
	removeMember,
	resolveMembership,
	savePolicy,
	setMemberPolicy,
} from './accounts';

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
	(await resolveMembership(db, catalogue, accountId, userId)) as Membership;

beforeEach(async () => {
	db = await createTestDb();
	ownerId = (await findOrCreateUser(db, 'ada@example.com')).id;
	bobId = (await findOrCreateUser(db, 'bob@example.com')).id;
	accountId = (await createAccount(db, { name: 'Acme', slug: 'acme' }, ownerId, NOW)).id;
	await addMember(db, accountId, bobId, 'member', NOW);
});

describe('accounts and memberships', () => {
	it('makes the creator owner and resolves policies', async () => {
		expect((await member(ownerId)).policy.key).toBe('owner');
		expect((await member(bobId)).policy.permissions).toEqual(['projects.read']);
		expect(await listAccountsForUser(db, bobId)).toMatchObject([
			{ policy: 'member', slug: 'acme' },
		]);
	});

	it('rejects taken and malformed slugs', async () => {
		await expect(createAccount(db, { name: 'X', slug: 'acme' })).rejects.toThrow('taken');
		await expect(createAccount(db, { name: 'X', slug: 'Bad Slug' })).rejects.toThrow();
	});

	it('only lets members with members.read list members', async () => {
		await expect(listMembers(db, await member(bobId))).rejects.toThrow('permission');
		expect(await listMembers(db, await member(ownerId))).toHaveLength(2);
	});
});

describe('the last owner', () => {
	it('cannot be demoted or removed, but can once there is another owner', async () => {
		const owner = await member(ownerId);
		await expect(removeMember(db, owner, ownerId)).rejects.toThrow('at least one owner');
		await setMemberPolicy(db, catalogue, owner, bobId, 'owner');
		await removeMember(db, owner, ownerId);
		expect(await resolveMembership(db, catalogue, accountId, ownerId)).toBeNull();
	});

	it('only owners confer ownership, and nobody changes their own policy', async () => {
		await setMemberPolicy(db, catalogue, await member(ownerId), bobId, 'admin');
		const admin = await member(bobId);
		const carol = (await findOrCreateUser(db, 'carol@example.com')).id;
		await addMember(db, accountId, carol, 'member');
		await expect(setMemberPolicy(db, catalogue, admin, carol, 'owner')).rejects.toThrow('owner');
		await expect(setMemberPolicy(db, catalogue, admin, ownerId, 'member')).rejects.toThrow('owner');
		await expect(setMemberPolicy(db, catalogue, admin, bobId, 'member')).rejects.toThrow('own');
		await setMemberPolicy(db, catalogue, admin, carol, 'admin');
	});
});

describe('custom policies', () => {
	it('are saved from catalogue keys, assigned, and protected while in use', async () => {
		const owner = await member(ownerId);
		await savePolicy(db, catalogue, owner, {
			key: 'editor',
			name: 'Editor',
			permissions: ['projects.*', 'members.read'],
		});
		await setMemberPolicy(db, catalogue, owner, bobId, 'editor');
		const editor = await member(bobId);
		expect(editor.policy.name).toBe('Editor');
		expect(await listMembers(db, editor)).toHaveLength(2);
		await expect(deletePolicy(db, owner, 'editor')).rejects.toThrow('Move its members');
		await expect(
			savePolicy(db, catalogue, owner, { key: 'x', name: 'X', permissions: ['*'] })
		).rejects.toThrow('Unknown permissions');
		await expect(
			savePolicy(db, catalogue, editor, { key: 'y', name: 'Y', permissions: [] })
		).rejects.toThrow('permission');
	});
});

describe('invites', () => {
	it('are accepted once, by the invited email only', async () => {
		const owner = await member(ownerId);
		const token = await createInvite(
			db,
			catalogue,
			owner,
			{ email: 'Carol@Example.com', policy: 'member' },
			NOW
		);
		expect(await findInvite(db, token, NOW)).toMatchObject({
			account: { slug: 'acme' },
			email: 'carol@example.com',
		});
		expect(await hasAccountAccess(db, 'carol@example.com', NOW)).toBe(true);

		const eve = await findOrCreateUser(db, 'eve@example.com');
		await expect(acceptInvite(db, token, eve, NOW)).rejects.toThrow('carol@example.com');

		const carol = await findOrCreateUser(db, 'carol@example.com');
		expect(await acceptInvite(db, token, carol, NOW)).toMatchObject({ slug: 'acme' });
		expect((await resolveMembership(db, catalogue, accountId, carol.id))?.policy.key).toBe(
			'member'
		);
		await expect(acceptInvite(db, token, carol, NOW)).rejects.toThrow(
			'expired or was already used'
		);
	});

	it('expire, and only owners invite owners', async () => {
		const owner = await member(ownerId);
		const token = await createInvite(
			db,
			catalogue,
			owner,
			{ email: 'c@example.com', policy: 'member' },
			NOW
		);
		expect(await findInvite(db, token, NOW + 8 * 24 * 60 * 60 * 1000)).toBeNull();
		await setMemberPolicy(db, catalogue, owner, bobId, 'admin');
		await expect(
			createInvite(db, catalogue, await member(bobId), { email: 'd@example.com', policy: 'owner' })
		).rejects.toThrow('owner');
		expect(await hasAccountAccess(db, 'nobody@example.com', NOW)).toBe(false);
	});
});
