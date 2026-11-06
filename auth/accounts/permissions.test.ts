import { describe, expect, it } from 'vitest';

import { builtInPolicies, grants, isGrantableKey, isValidPolicyKey } from './permissions';

const catalogue = {
	memberPermissions: ['projects.read'],
	permissions: ['projects.read', 'projects.edit', 'agents.create'],
};

describe('grants', () => {
	it('matches exact keys and wildcards', () => {
		expect(grants(['projects.read'], 'projects.read')).toBe(true);
		expect(grants(['projects.read'], 'projects.edit')).toBe(false);
		expect(grants(['projects.*'], 'projects.edit')).toBe(true);
		expect(grants(['projects.*'], 'agents.create')).toBe(false);
		expect(grants(['*'], 'anything.at-all')).toBe(true);
	});
});

describe('built-in policies', () => {
	const policies = builtInPolicies(catalogue);

	it('gives owners everything and admins all but policy management', () => {
		expect(grants(policies.owner.permissions, 'policies.manage')).toBe(true);
		expect(grants(policies.admin.permissions, 'members.manage')).toBe(true);
		expect(grants(policies.admin.permissions, 'projects.edit')).toBe(true);
		expect(grants(policies.admin.permissions, 'policies.manage')).toBe(false);
	});

	it("gives members the app's member permissions only", () => {
		expect(grants(policies.member.permissions, 'projects.read')).toBe(true);
		expect(grants(policies.member.permissions, 'projects.edit')).toBe(false);
		expect(grants(policies.member.permissions, 'members.read')).toBe(false);
	});
});

describe('custom policy validation', () => {
	it('accepts catalogue keys and resource wildcards, never *', () => {
		expect(isGrantableKey(catalogue, 'projects.edit')).toBe(true);
		expect(isGrantableKey(catalogue, 'members.invite')).toBe(true);
		expect(isGrantableKey(catalogue, 'projects.*')).toBe(true);
		expect(isGrantableKey(catalogue, '*')).toBe(false);
		expect(isGrantableKey(catalogue, 'billing.*')).toBe(false);
		expect(isGrantableKey(catalogue, 'projects.delete')).toBe(false);
	});

	it('rejects built-in and malformed keys', () => {
		expect(isValidPolicyKey('support')).toBe(true);
		expect(isValidPolicyKey('owner')).toBe(false);
		expect(isValidPolicyKey('Has Space')).toBe(false);
	});
});
