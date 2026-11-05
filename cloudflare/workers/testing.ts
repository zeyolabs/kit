import type { WorkerContext } from '.';

/** Builds a `WorkerContext` for calling an `HttpHandler` directly in a test, same shape
 *  `WorkerRouter.fetch` would build for a real request. */
export function fakeContext<Env>(request: Request, url: URL, env: Env): WorkerContext<Env> {
	return {
		env,
		executionCtx: { waitUntil: () => {} } as unknown as ExecutionContext,
		json: (data, status = 200) => Response.json(data, { status }),
		req: request,
		route: url.pathname,
		url,
	};
}

/** In-memory `DurableObjectStorage` stand-in for tests: `get`/`put`/`list` (single-key and
 *  bulk forms) and a single-slot alarm (`getAlarm`/`setAlarm`/`deleteAlarm`) round-trip for
 *  real, no real DO runtime needed. `list`'s `prefix`/`reverse` match real key-ordering
 *  semantics (lexicographic). The returned client also carries a `reset()`.
 *
 *  `DurableObjectStorage` is a large interface (`sql`, `kv`, `transaction`, bookmarks) — only
 *  `get`/`put`/`list`/the alarm methods are implemented, since that's the entire surface any
 *  current caller uses. Everything else throws instead of silently no-op'ing, so a caller that
 *  reaches past these gets a loud failure at the call site, not a silent gap — same stance as
 *  `mockRedis()` (`packages/kit/storage/redis/testing.ts`). Add a case if a test needs one. */
export function mockDurableObjectStorage(): DurableObjectStorage & { reset: () => void } {
	const rows = new Map<string, unknown>();
	let alarm: null | number = null;

	function get<T>(key: string): Promise<T | undefined>;
	function get<T>(keys: string[]): Promise<Map<string, T>>;
	function get<T>(keyOrKeys: string | string[]): Promise<Map<string, T> | T | undefined> {
		if (Array.isArray(keyOrKeys)) {
			const out = new Map<string, T>();
			for (const k of keyOrKeys) {
				if (rows.has(k)) out.set(k, rows.get(k) as T);
			}
			return Promise.resolve(out);
		}
		return Promise.resolve(rows.get(keyOrKeys) as T | undefined);
	}

	function put<T>(key: string, value: T): Promise<void>;
	function put<T>(entries: Record<string, T>): Promise<void>;
	function put<T>(keyOrEntries: Record<string, T> | string, value?: T): Promise<void> {
		if (typeof keyOrEntries === 'string') {
			rows.set(keyOrEntries, value);
		} else {
			for (const [k, v] of Object.entries(keyOrEntries)) rows.set(k, v);
		}
		return Promise.resolve();
	}

	function list<T>(options?: DurableObjectListOptions): Promise<Map<string, T>> {
		const prefix = options?.prefix ?? '';
		let keys = [...rows.keys()].filter((k) => k.startsWith(prefix)).sort();
		if (options?.reverse) keys = keys.reverse();
		if (options?.limit !== undefined) keys = keys.slice(0, options.limit);
		const out = new Map<T extends never ? never : string, T>();
		for (const k of keys) out.set(k as never, rows.get(k) as T);
		return Promise.resolve(out as Map<string, T>);
	}

	const notImplemented = (method: string) => () => {
		throw new Error(`mockDurableObjectStorage(): "${method}" is not implemented`);
	};

	return {
		delete: notImplemented('delete'),
		deleteAlarm: () => {
			alarm = null;
			return Promise.resolve();
		},
		deleteAll: notImplemented('deleteAll'),
		get,
		getAlarm: () => Promise.resolve(alarm),
		getBookmarkForTime: notImplemented('getBookmarkForTime'),
		getCurrentBookmark: notImplemented('getCurrentBookmark'),
		list,
		onNextSessionRestoreBookmark: notImplemented('onNextSessionRestoreBookmark'),
		put,
		reset: () => {
			rows.clear();
			alarm = null;
		},
		setAlarm: (time: Date | number) => {
			alarm = time instanceof Date ? time.getTime() : time;
			return Promise.resolve();
		},
		sync: notImplemented('sync'),
		transaction: notImplemented('transaction'),
		transactionSync: notImplemented('transactionSync'),
	} as unknown as DurableObjectStorage & { reset: () => void };
}
