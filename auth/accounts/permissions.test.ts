import { describe, expect, it } from 'vitest';

import { Permissions } from './permissions';

const catalogue = {
	memberPermissions: ['projects.read'],
	permissions: ['projects.read', 'projects.edit', 'agents.create'],
};

describe('Permissions.grants', () => {
	it('matches exact keys and wildcards', () => {
		expect(Permissions.grants(['projects.read'], 'projects.read')).toBe(true);
		expect(Permissions.grants(['projects.read'], 'projects.edit')).toBe(false);
		expect(Permissions.grants(['projects.*'], 'projects.edit')).toBe(true);
		expect(Permissions.grants(['projects.*'], 'agents.create')).toBe(false);
		expect(Permissions.grants(['*'], 'anything.at-all')).toBe(true);
	});
});

describe('built-in policies', () => {
	const policies = Permissions.builtIns(catalogue);

	it('gives owners everything and admins all but policy management', () => {
		expect(Permissions.grants(policies.owner.permissions, 'policies.manage')).toBe(true);
		expect(Permissions.grants(policies.admin.permissions, 'members.manage')).toBe(true);
		expect(Permissions.grants(policies.admin.permissions, 'projects.edit')).toBe(true);
		expect(Permissions.grants(policies.admin.permissions, 'policies.manage')).toBe(false);
	});

	it("gives members the app's member permissions only", () => {
		expect(Permissions.grants(policies.member.permissions, 'projects.read')).toBe(true);
		expect(Permissions.grants(policies.member.permissions, 'projects.edit')).toBe(false);
		expect(Permissions.grants(policies.member.permissions, 'members.read')).toBe(false);
	});
});

describe('custom policy validation', () => {
	it('accepts catalogue keys and resource wildcards, never *', () => {
		expect(Permissions.isGrantable(catalogue, 'projects.edit')).toBe(true);
		expect(Permissions.isGrantable(catalogue, 'members.invite')).toBe(true);
		expect(Permissions.isGrantable(catalogue, 'projects.*')).toBe(true);
		expect(Permissions.isGrantable(catalogue, '*')).toBe(false);
		expect(Permissions.isGrantable(catalogue, 'billing.*')).toBe(false);
		expect(Permissions.isGrantable(catalogue, 'projects.delete')).toBe(false);
	});

	it('rejects built-in and malformed keys', () => {
		expect(Permissions.isValidKey('support')).toBe(true);
		expect(Permissions.isValidKey('owner')).toBe(false);
		expect(Permissions.isValidKey('Has Space')).toBe(false);
	});
});
