// Fleet-wide boolean flags over a GATES Workers VPC binding (see the separate `gates` repo). No
// ambient context, no app-specific knowledge — the binding is passed in; the caller decides where
// it comes from.

export type Gate = { key: string; namespace: string; value: boolean };

const FRESH_MS = 5_000; // skip a refetch within this long of the last successful read
const STALE_MAX_MS = 60_000; // how long a failed fetch may still use the last successful read

type FlagCacheEntry = { fetchedAt: number; value: boolean };
const flagCache = new Map<string, FlagCacheEntry>(); // isolate-shared, not per-instance

/** Just the shape callers depend on — a test can hand-write a fake object matching this, or use
 *  `FakeGatesClient` from `./testing`, instead of constructing `GatesClient` with a fake binding. */
export interface IGatesClient {
	delete(namespace: string, key: string): Promise<void>;
	get(namespace: string, key: string): Promise<Gate | null>;
	getFlag(identifier: string, fallback: boolean): Promise<boolean>;
	list(namespace: string): Promise<Gate[]>;
	set(namespace: string, key: string, value: boolean): Promise<Gate>;
}

export class GatesClient implements IGatesClient {
	constructor(private readonly binding: Fetcher) {}

	async delete(namespace: string, key: string): Promise<void> {
		const res = await this.binding.fetch(`http://gates${this.path(namespace, key)}`, {
			method: 'DELETE',
		});
		if (!res.ok && res.status !== 404) {
			throw new Error(`GatesClient.delete ${namespace}/${key}: ${res.status}`);
		}
	}

	async get(namespace: string, key: string): Promise<Gate | null> {
		const res = await this.binding.fetch(`http://gates${this.path(namespace, key)}`);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GatesClient.get ${namespace}/${key}: ${res.status}`);
		return res.json();
	}

	/** `identifier` is `namespace/key`. Cached, never-throws boolean read: fresh cache within
	 *  `FRESH_MS`, else refetch; on failure, reuse the last good value within `STALE_MAX_MS`, else
	 *  `fallback`. */
	async getFlag(identifier: string, fallback: boolean): Promise<boolean> {
		const [namespace, key] = identifier.split('/');
		const cached = flagCache.get(identifier);
		const now = Date.now();
		if (cached && now - cached.fetchedAt < FRESH_MS) return cached.value;

		try {
			const gate = await this.get(namespace, key);
			const value = gate?.value ?? fallback;
			flagCache.set(identifier, { fetchedAt: now, value });
			return value;
		} catch (e) {
			const stillFresh = cached && now - cached.fetchedAt < STALE_MAX_MS;
			console.warn(
				`gates: ${identifier} unreachable, ${stillFresh ? 'using last known value' : 'no recent value, using fallback'}`,
				{
					error: e instanceof Error ? e.message : String(e),
					fallback: stillFresh ? cached.value : fallback,
				}
			);
			return stillFresh ? cached.value : fallback;
		}
	}

	async list(namespace: string): Promise<Gate[]> {
		const res = await this.binding.fetch(
			`http://gates/v1/namespaces/${encodeURIComponent(namespace)}/gates`
		);
		if (!res.ok) throw new Error(`GatesClient.list ${namespace}: ${res.status}`);
		return res.json();
	}

	async set(namespace: string, key: string, value: boolean): Promise<Gate> {
		const res = await this.binding.fetch(`http://gates${this.path(namespace, key)}`, {
			body: JSON.stringify({ value }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT',
		});
		if (!res.ok) throw new Error(`GatesClient.set ${namespace}/${key}: ${res.status}`);
		return res.json();
	}

	private path(namespace: string, key: string): string {
		return `/v1/namespaces/${encodeURIComponent(namespace)}/gates/${encodeURIComponent(key)}`;
	}
}
