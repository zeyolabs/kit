/** Config vars (`vars` in wrangler.jsonc) AND secrets (Secrets Store bindings in prod, plain
 *  strings in local `.dev.vars`/`.env`) — one store for both. Construct directly in tests
 *  (`new EnvStore({ AUTH_URL: '...' })`) — real validation logic, no fake method stubs to keep in
 *  sync. Production gets the one real instance via `resolve()`/`envStore()` below. */
export class EnvStore {
	private static instance: EnvStore | null = null;

	private readonly secrets: Record<string, string> = {};

	constructor(private readonly env: Record<string, unknown>) {}

	static current(): EnvStore {
		if (!EnvStore.instance) throw new Error('EnvStore.resolve() has not run yet');
		return EnvStore.instance;
	}

	/** Test-only: clears the cached instance so the next `resolve()` call rebuilds against
	 *  whatever env is current. A real isolate never needs this — the binding is isolate-stable
	 *  for its whole lifetime; only a test process resolving many different envs does. */
	static resetForTests(): void {
		EnvStore.instance = null;
	}

	/** Builds the one real instance for this isolate — idempotent. Called from `runWithContext`,
	 *  or directly (a Durable Object, say) if that never runs. Takes `unknown` so callers never
	 *  need their own cast.
	 *
	 *  Eagerly resolves every binding named in `secretNames` so `secret()` can stay sync afterward.
	 *  Gated on the name, not the binding's shape: Secrets Store, Service Bindings, and VPC services
	 *  are all backed by the identical `Fetcher` RPC stub (same `constructor.name`, same prototype,
	 *  zero own keys — verified live), so a prior attempt at excluding fetch-shaped bindings from
	 *  this scan (#1262) instead excluded every real secret too and broke them all in prod (reverted
	 *  in #1263). Filtering by name is the only signal that's actually reliable, and as a side
	 *  effect it also means `.get()` is never called on a Service/VPC binding, so it stops causing a
	 *  spurious cross-worker RPC exception log too. `secretNames` itself is app config
	 *  (the names of the Secrets Store bindings), not here — this package stays account-agnostic, the actual
	 *  list of real secret names is per-app config.
	 *
	 *  Local resolution is unreliable in two distinct ways (see the wiki): `.get()` can throw (an
	 *  unseeded binding), or it can resolve cleanly to something that isn't a real secret at all —
	 *  `null`, or even a non-string value. Either case falls back to a same-named `process.env`
	 *  value (populated from `.env` by the SvelteKit/Vite dev server) so `secret()` works the same
	 *  locally as in prod without every app re-implementing this fallback itself; if that's unset
	 *  too, the secret is left unresolved, surfaced only if something actually reads it via
	 *  `secret()`. `process` is absent in the real Workers runtime (no `nodejs_compat` polyfill
	 *  covers it here), so this fallback only ever fires under local dev. */
	static async resolve(env: unknown, secretNames: ReadonlySet<string>): Promise<void> {
		if (EnvStore.instance) return;
		const raw = env as Record<string, unknown>;
		const instance = new EnvStore(raw);
		const nodeEnv = typeof process === 'undefined' ? undefined : process.env;
		await Promise.all(
			Object.entries(raw).map(async ([name, value]) => {
				if (
					secretNames.has(name) &&
					value != null &&
					typeof value === 'object' &&
					typeof (value as { get?: unknown }).get === 'function'
				) {
					let resolved: string | undefined;
					try {
						const got = await (value as { get(): Promise<unknown> }).get();
						resolved = typeof got === 'string' && got.length > 0 ? got : undefined;
					} catch {
						resolved = undefined;
					}
					const fallback = resolved ?? nodeEnv?.[name];
					if (fallback) instance.secrets[name] = fallback;
				}
			})
		);
		EnvStore.instance = instance;
	}

	/** Any other raw binding (Workers AI, R2, a Durable Object namespace, …) that isn't a plain
	 *  var/VPC-fetch-shaped/secret — just existence-checked, then handed back as `T`. */
	binding<T>(name: string): T {
		const value = this.env[name];
		if (!value) throw new Error(`EnvStore: "${name}" binding is not configured`);
		return value as T;
	}

	/** A Cloudflare Hyperdrive binding. */
	hyperdrive(name: string): Hyperdrive {
		return this.binding<Hyperdrive>(name);
	}

	/** A numeric `vars` entry (e.g. `SENDER_BATCH_LIMIT: "500"`) — still a string in
	 *  wrangler.jsonc, parsed and validated here instead of a bare `Number(...)` at the call site,
	 *  which silently produces `NaN` on a bad value rather than failing. */
	int(name: string): number {
		const value = this.string(name);
		const parsed = Number(value);
		if (!Number.isInteger(parsed))
			throw new Error(`EnvStore: "${name}" ("${value}") is not an integer`);
		return parsed;
	}

	/** A secret — a Secrets Store binding in prod (resolved once in `resolve()` for names in
	 *  `SECRET_STORE_BINDING_NAMES`), or a plain string in local `.dev.vars`/`.env`. A name missing
	 *  from that set just fails loudly here at first call instead of at compile time, same tradeoff
	 *  `string()` already makes. */
	secret(name: string): string {
		const resolved = this.secrets[name];
		if (resolved != null) return resolved;
		const value = this.env[name];
		if (typeof value === 'string') return value;
		throw new Error(`EnvStore: "${name}" secret is not configured in this env`);
	}

	/** Same as `secret()` but for a secret that's genuinely optional — `null` instead of throwing
	 *  when unresolved (unset in this env, or an unseeded local Secrets Store binding with no
	 *  `.env` fallback either). */
	secretNull(name: string): null | string {
		const resolved = this.secrets[name];
		if (resolved != null) return resolved;
		const value = this.env[name];
		return typeof value === 'string' && value !== '' ? value : null;
	}

	/** No enumerated key list: this env's own vars vary too widely per app/worker to maintain one,
	 *  and a typo'd name still fails loudly, just at first call instead of at compile time. */
	string(name: string): string {
		const value = this.lookup(name);
		if (typeof value !== 'string') throw new Error(`EnvStore: "${name}" is not a string`);
		return value;
	}

	/** Same as `string()` but for a var that's genuinely optional (some apps/workers set it,
	 *  others don't) — `null` instead of throwing when unset. */
	stringNull(name: string): null | string {
		const value = this.env[name];
		if (value == null || value === '') return null;
		if (typeof value !== 'string') throw new Error(`EnvStore: "${name}" is not a string`);
		return value;
	}

	/** A Workers VPC Service binding (`fetch`/`connect`, real Cloudflare shape — no cast needed at
	 *  the call site). */
	vpc(name: string): Fetcher {
		const value = this.env[name];
		if (!value) throw new Error(`EnvStore: "${name}" VPC binding is not configured`);
		return value as Fetcher;
	}

	/** Same as `vpc()` but for a VPC binding that's genuinely optional (e.g. local dev has no VPC
	 *  services at all) — `null` instead of throwing when unset. */
	vpcNull(name: string): Fetcher | null {
		const value = this.env[name];
		return value ? (value as Fetcher) : null;
	}

	private lookup(name: string): unknown {
		const value = this.env[name];
		if (
			value != null &&
			typeof value === 'object' &&
			typeof (value as { get?: unknown }).get === 'function'
		) {
			throw new Error(`EnvStore: "${name}" is a Secrets Store binding — use secret() instead`);
		}
		if (value == null || value === '') {
			throw new Error(`EnvStore: "${name}" is not configured in this env`);
		}
		return value;
	}
}

export function envStore(): EnvStore {
	return EnvStore.current();
}
