// Generic Postgres-over-Cloudflare-Hyperdrive infra — no app domain knowledge. The schema is
// generic (TSchema): kit never imports it, just forwards whatever the caller hands it to drizzle.
// `drizzle-orm` itself is a fine kit dependency (a generic third-party ORM); the app's actual
// schema never enters kit — it stays in the app, the only place that knows what it is.
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type PostgresClientConfig = {
	connectionTimeoutMs?: number;
	poolMax?: number;
	queryTimeoutMs?: number;
};

/** A small `pg.Pool`, not a single `pg.Client` — Hyperdrive pools cheaply at the edge, and a lone
 *  `Client` only serves one in-flight query at a time. One per request/invocation: opened lazily
 *  (a pooled connection only dials on first query), closed via `close()` at the end. */
export class PostgresClient<TSchema extends Record<string, unknown>> {
	readonly db: NodePgDatabase<TSchema>;
	private readonly pool: pg.Pool;

	constructor(hyperdrive: Hyperdrive, schema: TSchema, config: PostgresClientConfig = {}) {
		const { connectionTimeoutMs = 10_000, poolMax = 5, queryTimeoutMs = 20_000 } = config;
		this.pool = new pg.Pool({
			connectionString: hyperdrive.connectionString,
			connectionTimeoutMillis: connectionTimeoutMs,
			max: poolMax,
			query_timeout: queryTimeoutMs,
		});
		// An idle pooled connection dropping (e.g. a WARP blip in dev) is otherwise an unhandled
		// 'error' event that crashes the process — in-flight query errors still propagate normally
		// through their own query() rejection, this only guards idle drops.
		this.pool.on('error', () => {});
		this.db = drizzle(this.pool, { schema });
	}

	/** Best-effort teardown — nothing actionable on a failed close. */
	async close(): Promise<void> {
		try {
			await this.pool.end();
		} catch {
			// best-effort teardown — nothing actionable on a failed close
		}
	}
}
