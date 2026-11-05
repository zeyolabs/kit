import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { Duplex } from 'node:stream';

import type { CfSocket, ManticoreConfig } from './schema';

import { logger } from '../../monitoring/logger/client';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9306;
const CONNECT_TIMEOUT_MS = 10_000;

/** mysql2 sets this exact code (see its `base/connection.js`) when the underlying socket closes —
 *  the only case worth a same-query retry, since the connection (not the query) was at fault. */
function isConnectionLost(err: unknown): boolean {
	return err instanceof Error && 'code' in err && err.code === 'PROTOCOL_CONNECTION_LOST';
}

type ManticoreClientConfig = {
	connectTimeoutMs?: number;
	password: string;
	/** `host:port` (optionally `mysql://host:port`) — ignored when a VPC binding resolves. */
	url?: string;
	user: string;
	/** The resolved Workers VPC Service binding (`.connect()` opens a raw socket to Manticore's
	 *  `:9306` MySQL listener) — the caller reads it off its own `EnvStore`
	 *  (`env.vpc('MANTICORE_VPC')`), not a binding name for this client to look up itself. Omit
	 *  if this runtime has none (local dev). */
	vpc?: Fetcher;
};

/** Parse `host:port` (optionally `mysql://host:port`) — defaults fill in whatever's missing. */
function parseUrl(url: string | undefined): { host: string; port: number } {
	if (!url) return { host: DEFAULT_HOST, port: DEFAULT_PORT };
	const stripped = url.replace(/^mysql:\/\//, '');
	const [host, port] = stripped.split(':');
	return { host: host || DEFAULT_HOST, port: port ? Number(port) : DEFAULT_PORT };
}

/** Bridge a Cloudflare socket (Web `readable`/`writable`) to a Node `Duplex` so mysql2 can speak the
 *  MySQL wire protocol over the VPC Service TCP socket. `Duplex.fromWeb` is available under
 *  `nodejs_compat`; mysql2 only reads/writes the stream, so the missing net-socket extras
 *  (`setNoDelay`/`setTimeout`) aren't needed. */
function toDuplex(socket: CfSocket): Duplex {
	// The Workers `ReadableStream`/`WritableStream` types (from workers-types) don't line up with the
	// `stream/web` types `Duplex.fromWeb` expects, though they're the same runtime objects — cast the
	// pair to the parameter type.
	return Duplex.fromWeb({
		readable: socket.readable,
		writable: socket.writable,
	} as unknown as Parameters<typeof Duplex.fromWeb>[0]);
}

/** Thin Manticore client over the MySQL protocol (mysql2). One MySQL connection per instance, opened
 *  lazily on first `query()` and cached for the instance's life. Per-request (a Workers TCP socket
 *  can't cross requests), not a per-isolate singleton like ClickHouse's HTTP client.
 *
 *  Queries use `conn.query` (client-side `?` interpolation), not `execute` (server-side prepared
 *  statements) — Manticore's prepared-statement support over MySQL is limited, and search SQL
 *  (`MATCH(...)`, faceting) is a poor ORM fit, so this stays a raw-SQL surface. */
export class ManticoreClient {
	private readonly config: ManticoreConfig;
	private connPromise: null | Promise<Connection> = null;

	constructor(config: ManticoreClientConfig) {
		const { connectTimeoutMs = CONNECT_TIMEOUT_MS, password, url, user, vpc } = config;
		// An explicit `url` (the local-dev override, `MANTICORE_URL` in `.dev.vars`) always wins over
		// `vpc`, even when `vpc` resolves truthy — under `vite dev`, `env.vpcNull('MANTICORE_VPC')`
		// hands back a connectable-looking stub for a `vpc_services` binding marked `"remote": true"`
		// regardless of the platformProxy's `remoteBindings: false`, and routing an actual `.connect()`
		// through it hits a Miniflare bug ("This ReadableStream is disturbed") — every query silently
		// returns no rows instead of throwing. Prod never sets a `MANTICORE_URL` var, so this is a
		// pure local-dev branch there.
		if (!vpc || url) {
			this.config = { ...parseUrl(url), connectTimeoutMs, password, user };
			return;
		}
		// Workers' `connect()` requires a non-empty address, but the VPC service routes to its own
		// registered target (`wrangler vpc service list`) and ignores this value.
		const address = url ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`;
		this.config = {
			connectTimeoutMs,
			password,
			socket: async () => vpc.connect(address),
			user,
		};
	}

	/** Close the connection if one was opened. Safe when never opened (lazy client, no query ran) and
	 *  best-effort — runs in the request-teardown `finally`, so a failed close must not throw. */
	async close(): Promise<void> {
		if (!this.connPromise) return;
		const conn = await this.connPromise.catch(() => null);
		this.connPromise = null;
		if (!conn) return;
		try {
			await conn.end();
		} catch {
			// best-effort close; nothing actionable on a failed teardown
		}
	}

	/** Run a read and return the rows. Params fill `?` placeholders (client-side interpolation). */
	async query<T = RowDataPacket>(sql: string, params?: unknown[]): Promise<T[]> {
		try {
			return await this.runQuery<T>(sql, params);
		} catch (err) {
			// A dropped connection (idle timeout, socket reset) is retried once on a fresh connection —
			// most callers only run one query per request, so dropping `connPromise` for "next call"
			// alone (as this used to) never actually got a retry: there was no next call. Anything else
			// (bad SQL, a genuine query error) isn't retried — it'll just fail the same way again.
			if (!isConnectionLost(err)) {
				await logger.error(err, { op: 'manticore', summary: sql });
				throw err;
			}
			try {
				return await this.runQuery<T>(sql, params);
			} catch (retryErr) {
				await logger.error(retryErr, { op: 'manticore', retried: true, summary: sql });
				throw retryErr;
			}
		}
	}

	private getConnection(): Promise<Connection> {
		return (this.connPromise ??= (async () => {
			const cfg = this.config;
			// Prod: tunnel through the VPC Service socket (resolved async), bridged to a Node duplex.
			// Dev: hand mysql2 host/port and let it dial the local Manticore itself.
			const stream = cfg.socket ? toDuplex(await cfg.socket()) : undefined;
			const conn = await mysql.createConnection({
				...(stream ? { stream } : { host: cfg.host, port: cfg.port }),
				connectTimeout: cfg.connectTimeoutMs,
				// mysql2's row parser is JIT-compiled via `new Function` unless this is set — Workers
				// has no `eval`/dynamic Function, so the first row-bearing result crashes mid-parse and
				// tears down the stream (surfaces as a misleading "server closed the connection").
				disableEval: true,
				// Manticore has no databases and rejects a CONNECT_WITH_DB handshake with ER_NO_DB_ERROR
				// (1046), so drop the capability and connect database-less, like the native `mysql` client.
				flags: ['-CONNECT_WITH_DB'],
				password: cfg.password,
				user: cfg.user,
			});
			// The connection can die between queries (idle timeout, socket reset) without another
			// query ever running to hit the catch in `query()` — drop the cache here too so the next
			// `getConnection()` call dials fresh instead of returning the same dead object forever.
			conn.on('error', () => {
				this.connPromise = null;
			});
			return conn;
		})());
	}

	private async runQuery<T>(sql: string, params?: unknown[]): Promise<T[]> {
		try {
			const conn = await this.getConnection();
			const [rows] = await conn.query(sql, params);
			return rows as T[];
		} catch (err) {
			// Leaves `connPromise` cached but unusable — drop it so the retry (or the next call, if this
			// was already the retry) dials fresh instead of reusing the same dead connection.
			this.connPromise = null;
			throw err;
		}
	}
}
