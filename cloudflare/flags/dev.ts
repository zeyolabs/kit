import type { IFlagsClient } from './client';

/** In-memory client for local dev where there is no Flagship binding: every flag reads as its
 *  fallback unless set. Use `set` from a dev script or REPL to flip one. */
export class FlagsDevClient implements IFlagsClient {
	private readonly store = new Map<string, boolean>();

	async getBoolean(key: string, fallback = false): Promise<boolean> {
		return this.store.get(key) ?? fallback;
	}

	set(key: string, value: boolean): void {
		this.store.set(key, value);
		console.log(`[flags:dev] ${key} = ${value}`);
	}
}
