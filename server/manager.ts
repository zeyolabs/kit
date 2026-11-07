import type { Membership } from '../auth/accounts/accounts';

import { Accounts } from '../auth/accounts/accounts';
import { Error403 } from '../utils/errors';

// The manager gate. A manager is permission check, then a service call, then events. Each edge (a
// SvelteKit hook, an MCP session, a Worker) resolves the principal its own way and passes the
// membership in, so managers need no request and are testable without one.

/** Throws a 403 unless `membership` grants `permission`. A missing membership fails closed. */
export function requirePermission(membership: Membership | null, permission: string): Membership {
	if (!membership || !Accounts.can(membership, permission)) {
		throw Error403('You do not have permission to do that');
	}
	return membership;
}

/** Runs `fn` with the checked membership, or throws a 403 before `fn` is called. */
export async function withPermission<T>(
	principal: { membership: Membership | null },
	permission: string,
	fn: (principal: { membership: Membership }) => Promise<T> | T
): Promise<T> {
	const membership = requirePermission(principal.membership, permission);
	return await fn({ membership });
}
