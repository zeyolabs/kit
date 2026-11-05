import type { CfSocket, RedisConfig } from './schema';

import { logger } from '../../monitoring/logger/client';
import { encodeCommand, parseReply, RespReader, type RespValue } from './protocol';

type Connection = {
	reader: RespReader;
	socket: CfSocket;
	writer: WritableStreamDefaultWriter<Uint8Array>;
};

/** Two ways a dropped connection surfaces, neither the command's fault: Cloudflare's TCP socket
 *  throws this exact message when the underlying connection resets (idle timeout, remote reset);
 *  `RespReader` throws its own "connection closed unexpectedly" (+ "(mid-bulk)") when the socket
 *  closes cleanly (a `read()` EOF) instead of throwing. Both are worth a same-command retry. */
function isConnectionLost(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.message === 'Network connection lost.' ||
			err.message.startsWith('Redis connection closed unexpectedly'))
	);
}

/** `HGETALL`'s flat `[field, value, field, value, ...]` reply as a plain object — `{}` for the
 *  empty-array reply a nonexistent key gives back. */
function flattenHash(flat: RespValue[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < flat.length; i += 2) out[flat[i] as string] = flat[i + 1] as string;
	return out;
}

/** Just the shape callers depend on — a test can hand-write a fake object matching this instead
 *  of constructing `RedisClient` with a fake socket/VPC binding. */
export interface IRedisClient {
	close(): Promise<void>;
	command(args: (number | string)[]): Promise<RespValue>;
	eval(script: string, keys: string[], args: (number | string)[]): Promise<RespValue>;
	hDel(key: string, ...fields: string[]): Promise<number>;
	hGetAll(key: string): Promise<Record<string, string>>;
	hGetAllMany(keys: string[]): Promise<Record<string, string>[]>;
	hSet(key: string, fields: Record<string, number | string>): Promise<number>;
	pipeline(commandsList: (number | string)[][]): Promise<RespValue[]>;
}

/** Thin Redis client over a hand-rolled RESP2 codec (`./protocol`) — one TCP connection per
 *  instance, opened lazily on first `command()` and cached for the instance's life. Per-request
 *  (a Workers TCP socket can't cross requests), same profile as `ManticoreClient`. `HGETALL`/
 *  `HSET`/`HDEL`/`EVAL` are exposed as typed methods; `command()` is the escape hatch for
 *  anything else. */
export class RedisClient implements IRedisClient {
	private connPromise: null | Promise<Connection> = null;
	// RESP is one request/reply pair at a time over a single connection — a socket's
	// ReadableStreamDefaultReader also physically rejects a second concurrent `read()` (`This
	// ReadableStream only supports a single pending read request at a time`). Callers do issue
	// concurrent commands on one instance (e.g. a bulk pacing load fires N HGETALLs in parallel),
	// so every command is queued through this chain to run strictly one at a time regardless of
	// call order — `.then(task, task)` runs the next task whether the previous one resolved or
	// rejected, and the reassignment always resolves so one failed command never wedges the queue.
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly config: RedisConfig) {}

	/** Close the connection if one was opened. Safe when never opened and best-effort — runs in the
	 *  request-teardown `finally`, so a failed close must not throw. */
	async close(): Promise<void> {
		if (!this.connPromise) return;
		const conn = await this.connPromise.catch(() => null);
		this.connPromise = null;
		if (!conn) return;
		try {
			await conn.socket.close();
		} catch {
			// best-effort teardown — nothing actionable on a failed close
		}
	}

	/** Run an arbitrary RESP command — the escape hatch `hGetAll`/`hSet` are built on. Queued (see
	 *  `queue`) so concurrent callers never share the connection's reader at the same instant. */
	async command(args: (number | string)[]): Promise<RespValue> {
		const run = async (): Promise<RespValue> => {
			const conn = await this.getConnection();
			await conn.writer.write(encodeCommand(args));
			return await parseReply(conn.reader);
		};
		const attempt = async (): Promise<RespValue> => {
			try {
				return await run();
			} catch (err) {
				// A dead connection (idle timeout, socket reset) leaves `connPromise` cached but unusable —
				// drop it so a retry (or the next call, if this was already the retry) reconnects instead
				// of reusing the same dead connection.
				this.connPromise = null;
				if (!isConnectionLost(err)) {
					await logger.error(err, { op: 'redis', summary: String(args[0]) });
					throw err;
				}
				try {
					return await run();
				} catch (retryErr) {
					this.connPromise = null;
					await logger.error(retryErr, { op: 'redis', retried: true, summary: String(args[0]) });
					throw retryErr;
				}
			}
		};
		const result = this.queue.then(attempt, attempt);
		this.queue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	/** `EVAL script numkeys key [key ...] arg [arg ...]` — the atomicity primitive for a
	 *  check-and-mutate a plain `HSET`/`HINCRBY` can't express on its own (Redis runs the whole
	 *  script as one operation, no other command can interleave). */
	async eval(script: string, keys: string[], args: (number | string)[]): Promise<RespValue> {
		return this.command(['EVAL', script, String(keys.length), ...keys, ...args]);
	}

	/** `HDEL key field [field ...]` — returns the count of fields actually removed. Absent, not
	 *  empty-string, is how a cleared stamp reads back (matching Postgres NULL, not `''`). */
	async hDel(key: string, ...fields: string[]): Promise<number> {
		return (await this.command(['HDEL', key, ...fields])) as number;
	}

	/** `HGETALL key` as a plain field→value object — `{}` for a nonexistent key, matching Redis'
	 *  own empty-array reply rather than a null one. */
	async hGetAll(key: string): Promise<Record<string, string>> {
		return flattenHash((await this.command(['HGETALL', key])) as RespValue[]);
	}

	/** `HGETALL` for many keys as one pipelined round trip instead of one round trip per key —
	 *  same result shape as `Promise.all(keys.map((k) => hGetAll(k)))`, in the same order, but the
	 *  N commands share a single network round trip (see `pipeline`). Use this over a manual
	 *  `Promise.all` of `hGetAll` calls whenever `keys.length` isn't always 1 — that pattern is
	 *  exactly what used to race the shared connection reader before `pipeline` existed. */
	async hGetAllMany(keys: string[]): Promise<Record<string, string>[]> {
		if (keys.length === 0) return [];
		const replies = await this.pipeline(keys.map((key) => ['HGETALL', key]));
		return replies.map((flat) => flattenHash(flat as RespValue[]));
	}

	/** `HSET key field value [field value ...]` — returns the count of NEW fields (Redis' own
	 *  semantics: an existing field being overwritten doesn't count). */
	async hSet(key: string, fields: Record<string, number | string>): Promise<number> {
		const args: (number | string)[] = ['HSET', key];
		for (const [field, value] of Object.entries(fields)) args.push(field, value);
		return (await this.command(args)) as number;
	}

	/** Send several commands as one network round trip instead of one round trip per command —
	 *  all writes go out before any reply is read back; RESP guarantees replies come back in the
	 *  same order the commands were sent, so `results[i]` answers `commandsList[i]`. Queued the
	 *  same as `command()` (as one unit — another caller's command can't land in the middle of a
	 *  pipeline's writes or reads). Prefer a typed wrapper (`hGetAllMany`) over calling this
	 *  directly where one exists. */
	async pipeline(commandsList: (number | string)[][]): Promise<RespValue[]> {
		const run = async (): Promise<RespValue[]> => {
			const conn = await this.getConnection();
			for (const args of commandsList) await conn.writer.write(encodeCommand(args));
			const results: RespValue[] = [];
			for (let i = 0; i < commandsList.length; i++) {
				results.push(await parseReply(conn.reader));
			}
			return results;
		};
		const attempt = async (): Promise<RespValue[]> => {
			try {
				return await run();
			} catch (err) {
				this.connPromise = null;
				if (!isConnectionLost(err)) {
					await logger.error(err, { op: 'redis', summary: `pipeline(${commandsList.length})` });
					throw err;
				}
				try {
					return await run();
				} catch (retryErr) {
					this.connPromise = null;
					await logger.error(retryErr, {
						op: 'redis',
						retried: true,
						summary: `pipeline(${commandsList.length})`,
					});
					throw retryErr;
				}
			}
		};
		const result = this.queue.then(attempt, attempt);
		this.queue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	/** Workers' `connect()` requires a non-empty address, but the VPC service routes to its own
	 *  registered target (`wrangler vpc service list`) and ignores this value — same as
	 *  `ManticoreClient`. */
	private async dialVpc(): Promise<CfSocket> {
		return this.config.vpc.connect('127.0.0.1:6379');
	}

	private getConnection(): Promise<Connection> {
		return (this.connPromise ??= (async () => {
			const socket = await this.dialVpc();
			const socketReader = socket.readable.getReader();
			const reader = new RespReader({ read: () => socketReader.read() });
			const writer = socket.writable.getWriter();

			await writer.write(encodeCommand(['AUTH', this.config.user, this.config.password]));
			const authReply = await parseReply(reader);
			if (authReply !== 'OK') throw new Error(`Redis AUTH failed: ${String(authReply)}`);

			return { reader, socket, writer };
		})());
	}
}
