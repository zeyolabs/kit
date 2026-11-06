// Permissions and policies. Pure (no db), so pages can use them too, e.g. to hide a button.
//
// A permission is a key like `projects.edit`: `<resource>.<action>`. A policy is a named set of
// keys; every account member has exactly one. A key may be a wildcard: `*` grants everything,
// `projects.*` every action on projects.
//
// Three policies are built in and exist in every account:
//   owner  - everything, including policies and conferring ownership; can't be edited
//   admin  - everything except managing policies
//   member - the app's `memberPermissions`
// An account can add its own policies (`account_policies`), made of the app's permission keys.

/** The permissions this module itself checks, for account management. */
export const ACCOUNT_PERMISSIONS = [
	'account.edit',
	'members.read',
	'members.invite',
	'members.manage',
	'policies.manage',
] as const;

export const BUILT_IN_POLICY_KEYS = ['owner', 'admin', 'member'] as const;
export type BuiltInPolicyKey = (typeof BUILT_IN_POLICY_KEYS)[number];

export type Policy = {
	builtIn: boolean;
	key: string;
	name: string;
	permissions: readonly string[];
};

/** The app's permission catalogue: every key a policy may grant, besides the account ones. */
export type PermissionCatalogue = {
	/** What a plain member gets. */
	memberPermissions: readonly string[];
	/** Every app permission key, e.g. `['projects.read', 'projects.edit', ...]`. */
	permissions: readonly string[];
};

export function isBuiltInPolicy(key: string): key is BuiltInPolicyKey {
	return (BUILT_IN_POLICY_KEYS as readonly string[]).includes(key);
}

export function builtInPolicies(catalogue: PermissionCatalogue): Record<BuiltInPolicyKey, Policy> {
	const everything = [...ACCOUNT_PERMISSIONS, ...catalogue.permissions];
	return {
		admin: {
			builtIn: true,
			key: 'admin',
			name: 'Admin',
			permissions: everything.filter((p) => p !== 'policies.manage'),
		},
		member: {
			builtIn: true,
			key: 'member',
			name: 'Member',
			permissions: catalogue.memberPermissions,
		},
		owner: { builtIn: true, key: 'owner', name: 'Owner', permissions: ['*'] },
	};
}

/** Whether `granted` (a policy's keys, wildcards allowed) includes `permission`. */
export function grants(granted: readonly string[], permission: string): boolean {
	const resource = permission.split('.')[0];
	return granted.some((g) => g === '*' || g === permission || g === `${resource}.*`);
}

/** Every key a custom policy may contain: exact catalogue keys, or `<resource>.*` for a resource
 *  in it. Never `*`, which only the owner policy holds. */
export function isGrantableKey(catalogue: PermissionCatalogue, key: string): boolean {
	const all = [...ACCOUNT_PERMISSIONS, ...catalogue.permissions];
	if (all.includes(key)) return true;
	const match = /^([a-z][a-z0-9-]*)\.\*$/.exec(key);
	return !!match && all.some((p) => p.startsWith(`${match[1]}.`));
}

/** Keys and names for a custom policy: `[a-z0-9-]`, 1-40 chars, not a built-in key. */
export function isValidPolicyKey(key: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,39}$/.test(key) && !isBuiltInPolicy(key);
}
