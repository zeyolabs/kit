import { describe, expect, it, vi } from 'vitest';

import type { CfSocket } from './schema';

import { RedisClient } from './client';

const encoder = new TextEncoder();

/** A fake `CfSocket` fed by a fixed queue of RESP2 reply strings (one `read()` per queued chunk) —
 *  simulates the server side of the wire without a real socket. `written` captures every byte the
 *  client sent, for asserting the AUTH handshake actually went out.
 *
 *  Models the one real constraint that matters for `RedisClient`'s command queue: a
 *  `ReadableStreamDefaultReader` rejects a second `read()` started before the first settles
 *  (`This ReadableStream only supports a single pending read request at a time.`) — each `read()`
 *  here yields a macrotask before resolving, so two calls that overlap in time (not just two
 *  calls in general) actually collide the same way a real stream would, and a broken command
 *  queue that lets two commands run concurrently fails this the same way it fails in prod. */
function fakeSocket(replies: string[]): { socket: CfSocket; written: Uint8Array[] } {
	const queue = [...replies];
	const written: Uint8Array[] = [];
	let pending = false;
	return {
		socket: {
			close: vi.fn(async () => {}),
			readable: {
				getReader: () => ({
					read: async () => {
						if (pending) {
							throw new TypeError(
								'This ReadableStream only supports a single pending read request at a time.'
							);
						}
						pending = true;
						await new Promise((resolve) => setTimeout(resolve, 0));
						pending = false;
						const next = queue.shift();
						return next
							? { done: false, value: encoder.encode(next) }
							: { done: true, value: undefined };
					},
				}),
			} as unknown as ReadableStream<Uint8Array>,
			writable: {
				getWriter: () => ({
					write: async (chunk: Uint8Array) => {
						written.push(chunk);
					},
				}),
			} as unknown as WritableStream<Uint8Array>,
		},
		written,
	};
}

/** A fake VPC binding — `Fetcher.connect()` is the only method `RedisClient` calls on it. */
function fakeVpc(connect: (address: string) => CfSocket | Promise<CfSocket>): Fetcher {
	return { connect: vi.fn(connect) } as unknown as Fetcher;
}

describe('RedisClient', () => {
	it('authenticates once, then reuses the connection across calls', async () => {
		const { socket, written } = fakeSocket([
			'+OK\r\n', // AUTH
			':1\r\n', // HSET
			'*2\r\n$14\r\nsent_in_window\r\n$1\r\n3\r\n', // HGETALL
		]);
		const vpc = fakeVpc(() => socket);
		const client = new RedisClient({ password: 'secret', user: 'test', vpc });

		expect(await client.hSet('inbox:1:send-state', { sent_in_window: 1 })).toBe(1);
		expect(await client.hGetAll('inbox:1:send-state')).toEqual({ sent_in_window: '3' });

		expect(vpc.connect).toHaveBeenCalledTimes(1); // one connection, reused
		expect(new TextDecoder().decode(written[0])).toContain('AUTH');
	});

	it('throws when AUTH is rejected', async () => {
		const { socket } = fakeSocket(['-WRONGPASS invalid username-password pair\r\n']);
		const client = new RedisClient({ password: 'wrong', user: 'test', vpc: fakeVpc(() => socket) });
		await expect(client.command(['PING'])).rejects.toThrow();
	});

	it('drops the cached connection after a failed command, so the next call reconnects', async () => {
		const first = fakeSocket(['+OK\r\n', '-ERR simulated failure\r\n']);
		const second = fakeSocket(['+OK\r\n', ':1\r\n']);
		const connect = vi
			.fn()
			.mockResolvedValueOnce(first.socket)
			.mockResolvedValueOnce(second.socket);
		const client = new RedisClient({
			password: 'secret',
			user: 'test',
			vpc: { connect } as unknown as Fetcher,
		});

		await expect(client.command(['GET', 'x'])).rejects.toThrow('simulated failure');
		expect(await client.hSet('inbox:1:send-state', { sent_in_window: 1 })).toBe(1);
		expect(connect).toHaveBeenCalledTimes(2);
	});

	it('retries once on a lost connection, transparently to the caller', async () => {
		const dead: CfSocket = {
			close: vi.fn(async () => {}),
			readable: {
				getReader: () => ({
					read: async () => {
						throw new Error('Network connection lost.');
					},
				}),
			} as unknown as ReadableStream<Uint8Array>,
			writable: {
				getWriter: () => ({ write: async () => {} }),
			} as unknown as WritableStream<Uint8Array>,
		};
		const fresh = fakeSocket(['+OK\r\n', ':1\r\n']);
		const connect = vi.fn().mockResolvedValueOnce(dead).mockResolvedValueOnce(fresh.socket);
		const client = new RedisClient({
			password: 'secret',
			user: 'test',
			vpc: { connect } as unknown as Fetcher,
		});

		expect(await client.hSet('inbox:1:send-state', { sent_in_window: 1 })).toBe(1);
		expect(connect).toHaveBeenCalledTimes(2); // dead connection, then a fresh dial for the retry
	});

	it('retries once on a clean EOF (RespReader\'s own "connection closed unexpectedly")', async () => {
		const eof: CfSocket = {
			close: vi.fn(async () => {}),
			readable: {
				getReader: () => ({
					read: async () => ({ done: true }),
				}),
			} as unknown as ReadableStream<Uint8Array>,
			writable: {
				getWriter: () => ({ write: async () => {} }),
			} as unknown as WritableStream<Uint8Array>,
		};
		const fresh = fakeSocket(['+OK\r\n', ':1\r\n']);
		const connect = vi.fn().mockResolvedValueOnce(eof).mockResolvedValueOnce(fresh.socket);
		const client = new RedisClient({
			password: 'secret',
			user: 'test',
			vpc: { connect } as unknown as Fetcher,
		});

		expect(await client.hSet('inbox:1:send-state', { sent_in_window: 1 })).toBe(1);
		expect(connect).toHaveBeenCalledTimes(2);
	});

	it('does not retry a second time — a lost connection on the retry itself still throws', async () => {
		const dead: CfSocket = {
			close: vi.fn(async () => {}),
			readable: {
				getReader: () => ({
					read: async () => {
						throw new Error('Network connection lost.');
					},
				}),
			} as unknown as ReadableStream<Uint8Array>,
			writable: {
				getWriter: () => ({ write: async () => {} }),
			} as unknown as WritableStream<Uint8Array>,
		};
		const connect = vi.fn().mockResolvedValue(dead);
		const client = new RedisClient({
			password: 'secret',
			user: 'test',
			vpc: { connect } as unknown as Fetcher,
		});

		await expect(client.command(['GET', 'x'])).rejects.toThrow('Network connection lost.');
		expect(connect).toHaveBeenCalledTimes(2); // original attempt + one retry, no more
	});

	it('hGetAll returns {} for a nonexistent key rather than throwing', async () => {
		const { socket } = fakeSocket(['+OK\r\n', '*0\r\n']);
		const client = new RedisClient({
			password: 'secret',
			user: 'test',
			vpc: fakeVpc(() => socket),
		});
		expect(await client.hGetAll('inbox:404:send-state')).toEqual({});
	});

	it('hDel returns the count of fields actually removed', async () => {
		const { socket, written } = fakeSocket(['+OK\r\n', ':1\r\n']);
		const client = new RedisClient({
			password: 'secret',
			user: 'test',
			vpc: fakeVpc(() => socket),
		});
		expect(await client.hDel('inbox:1:send-state', 'warmup_next_available_at')).toBe(1);
		expect(new TextDecoder().decode(written[1])).toContain('HDEL');
	});

	it('serializes concurrent commands on one instance instead of racing the shared reader', async () => {
		// A bulk pacing load fires N HGETALLs in parallel on one RedisClient (see
		// `loadInboxSendStates`) — without a command queue, two of these overlapping in time
		// crash with the same "single pending read" error `fakeSocket` now models.
		const { socket } = fakeSocket([
			'+OK\r\n', // AUTH
			'*2\r\n$14\r\nsent_in_window\r\n$1\r\n1\r\n', // HGETALL inbox:1
			'*2\r\n$14\r\nsent_in_window\r\n$1\r\n2\r\n', // HGETALL inbox:2
			'*2\r\n$14\r\nsent_in_window\r\n$1\r\n3\r\n', // HGETALL inbox:3
		]);
		const client = new RedisClient({
			password: 'secret',
			user: 'test',
			vpc: fakeVpc(() => socket),
		});

		const results = await Promise.all([
			client.hGetAll('inbox:1:send-state'),
			client.hGetAll('inbox:2:send-state'),
			client.hGetAll('inbox:3:send-state'),
		]);

		expect(results).toEqual([
			{ sent_in_window: '1' },
			{ sent_in_window: '2' },
			{ sent_in_window: '3' },
		]);
	});

	it('hGetAllMany fetches many keys in one pipelined round trip, in order', async () => {
		const { socket, written } = fakeSocket([
			'+OK\r\n', // AUTH
			'*2\r\n$14\r\nsent_in_window\r\n$1\r\n1\r\n', // HGETALL inbox:1
			'*0\r\n', // HGETALL inbox:2 — nonexistent key
			'*2\r\n$14\r\nsent_in_window\r\n$1\r\n3\r\n', // HGETALL inbox:3
		]);
		const client = new RedisClient({
			password: 'secret',
			user: 'test',
			vpc: fakeVpc(() => socket),
		});

		const results = await client.hGetAllMany([
			'inbox:1:send-state',
			'inbox:2:send-state',
			'inbox:3:send-state',
		]);

		expect(results).toEqual([{ sent_in_window: '1' }, {}, { sent_in_window: '3' }]);
		// All 3 HGETALLs went out as one batch of writes (right after AUTH), not interleaved with reads.
		expect(written).toHaveLength(4);
		for (let i = 1; i < 4; i++) expect(new TextDecoder().decode(written[i])).toContain('HGETALL');
	});

	it('hGetAllMany returns [] for an empty key list without touching the connection', async () => {
		const vpc = fakeVpc(() => fakeSocket([]).socket);
		const client = new RedisClient({ password: 'secret', user: 'test', vpc });
		expect(await client.hGetAllMany([])).toEqual([]);
		expect(vpc.connect).not.toHaveBeenCalled();
	});

	it('eval sends EVAL with numkeys, keys, then args, and returns the script result', async () => {
		const { socket, written } = fakeSocket(['+OK\r\n', ':1\r\n']);
		const client = new RedisClient({
			password: 'secret',
			user: 'test',
			vpc: fakeVpc(() => socket),
		});
		const result = await client.eval('return 1', ['inbox:1:send-state'], [Date.now(), 500]);
		expect(result).toBe(1);
		const sent = new TextDecoder().decode(written[1]);
		expect(sent).toContain('EVAL');
		expect(sent).toContain('$1\r\n1\r\n'); // numkeys
		expect(sent).toContain('inbox:1:send-state');
	});
});
