import { describe, expect, it, vi } from 'vitest';

import type { Membership } from '../auth/accounts/accounts';

import { backgroundPublisher, mutation } from './layers';
import { requirePermission, withPermission } from './manager';

function membershipWith(...permissions: string[]): Membership {
	return {
		accountId: 1,
		policy: { builtIn: false, key: 'custom', name: 'Custom', permissions },
		userId: 2,
	};
}

describe('requirePermission', () => {
	it('returns the membership when it grants the permission', () => {
		const membership = membershipWith('projects.edit');
		expect(requirePermission(membership, 'projects.edit')).toBe(membership);
	});

	it('accepts a resource wildcard', () => {
		expect(requirePermission(membershipWith('projects.*'), 'projects.edit').userId).toBe(2);
	});

	it('throws 403 when the permission is missing', () => {
		expect(() => requirePermission(membershipWith('projects.read'), 'projects.edit')).toThrow(
			'permission'
		);
	});

	it('fails closed with no membership', () => {
		expect(() => requirePermission(null, 'projects.read')).toThrow('permission');
	});
});

describe('withPermission', () => {
	it('runs fn with the checked membership', async () => {
		const membership = membershipWith('projects.read');
		const result = await withPermission(
			{ membership },
			'projects.read',
			({ membership: m }) => m.userId
		);
		expect(result).toBe(2);
	});

	it('does not call fn when denied', async () => {
		const fn = vi.fn();
		await expect(withPermission({ membership: null }, 'projects.read', fn)).rejects.toThrow(
			'permission'
		);
		expect(fn).not.toHaveBeenCalled();
	});
});

describe('mutation', () => {
	it('carries the value and its events, defaulting to none', () => {
		expect(mutation('ok', ['created'])).toEqual({ events: ['created'], value: 'ok' });
		expect(mutation(1).events).toEqual([]);
	});
});

describe('backgroundPublisher', () => {
	it('sends events without throwing when send fails', async () => {
		const onError = vi.fn();
		const publisher = backgroundPublisher(async () => {
			throw new Error('hub down');
		}, onError);
		expect(() => publisher.publish(['a'])).not.toThrow();
		await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
	});

	it('does nothing for an empty batch', () => {
		const send = vi.fn(async () => {});
		backgroundPublisher(send).publish([]);
		expect(send).not.toHaveBeenCalled();
	});
});
