import type { IFlagsClient } from './client';

/** In-memory `FlagsClient` stand-in for tests: seed flags with `set`, no binding needed. */
export class FakeFlagsClient implements IFlagsClient {
	private readonly store = new Map<string, boolean>();

	async getBoolean(key: string, fallback = false): Promise<boolean> {
		return this.store.get(key) ?? fallback;
	}

	set(key: string, value: boolean): void {
		this.store.set(key, value);
	}
}
