import { AsyncLocalStorage } from 'node:async_hooks';

import { EnvStore } from '../utils/env';

/** Per-request/invocation cache with teardown tracking, holding the raw runtime `env`. */
export class ContextStore {
	private cache = new Map<string, unknown>();
	private closers: Array<() => Promise<void>> = [];

	constructor(readonly env: object) {}

	async closeAll(): Promise<void> {
		await Promise.allSettled(this.closers.map((c) => c()));
	}

	once<T>(key: string, build: () => T, close?: (v: T) => Promise<void>): T {
		if (!this.cache.has(key)) {
			const v = build();
			this.cache.set(key, v);
			if (close) this.closers.push(() => close(v));
		}
		return this.cache.get(key) as T;
	}

	/** For a binding whose construction is app-specific and can't be built generically here. */
	provide<T>(key: string, value: T): void {
		this.cache.set(key, value);
	}

	require<T>(key: string): T {
		if (!this.cache.has(key)) {
			throw new Error(
				`Context key "${key}" was never provided — call store.provide("${key}", …) first`
			);
		}
		return this.cache.get(key) as T;
	}
}

const als = new AsyncLocalStorage<ContextStore>();

/** Wrap one request/invocation in this — whatever gets built during the call is closed
 *  automatically when it returns. `secretNames`: the app's list of Secrets Store binding names. */
export async function runWithContext<T>(
	env: object,
	secretNames: ReadonlySet<string>,
	fn: () => Promise<T>
): Promise<T> {
	await EnvStore.resolve(env, secretNames);
	const store = new ContextStore(env);
	try {
		return await als.run(store, fn);
	} finally {
		await store.closeAll();
	}
}

export function currentContext(): ContextStore {
	const store = als.getStore();
	if (!store) {
		throw new Error(
			'No context — call runWithContext(env, fn) at the top of the request/invocation'
		);
	}
	return store;
}
