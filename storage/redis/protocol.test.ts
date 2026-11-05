import { describe, expect, it } from 'vitest';

import { type ByteSource, encodeCommand, parseReply, RespReader } from './protocol';

const encoder = new TextEncoder();

/** A `ByteSource` that hands out the given chunks one `read()` at a time, then signals `done` —
 *  splitting a reply across arbitrary chunk boundaries is the whole point: a real TCP socket never
 *  guarantees one `read()` per RESP frame. */
function fakeSource(chunks: string[]): ByteSource {
	const queue = chunks.map((c) => encoder.encode(c));
	return {
		read: async () => {
			const value = queue.shift();
			return value ? { done: false, value } : { done: true };
		},
	};
}

describe('encodeCommand', () => {
	it('encodes a multi-arg command as a RESP2 bulk-string array', () => {
		const bytes = encodeCommand(['HSET', 'inbox:1:send-state', 'sent_in_window', 3]);
		const text = new TextDecoder().decode(bytes);
		// Built from each arg's own byte length rather than hand-counted literals — a hand-typed
		// `$<n>` is exactly the kind of off-by-one this test exists to catch, not introduce.
		const expected = ['HSET', 'inbox:1:send-state', 'sent_in_window', '3']
			.map((arg) => `$${encoder.encode(arg).length}\r\n${arg}\r\n`)
			.join('');
		expect(text).toBe(`*4\r\n${expected}`);
	});
});

describe('parseReply', () => {
	it('parses a simple string', async () => {
		const reader = new RespReader(fakeSource(['+OK\r\n']));
		expect(await parseReply(reader)).toBe('OK');
	});

	it('throws on an error reply', async () => {
		const reader = new RespReader(fakeSource(['-ERR wrong number of arguments\r\n']));
		await expect(parseReply(reader)).rejects.toThrow('ERR wrong number of arguments');
	});

	it('parses an integer', async () => {
		const reader = new RespReader(fakeSource([':2\r\n']));
		expect(await parseReply(reader)).toBe(2);
	});

	it('parses a bulk string', async () => {
		const reader = new RespReader(fakeSource(['$5\r\nhello\r\n']));
		expect(await parseReply(reader)).toBe('hello');
	});

	it('parses a null bulk string (missing key/field)', async () => {
		const reader = new RespReader(fakeSource(['$-1\r\n']));
		expect(await parseReply(reader)).toBeNull();
	});

	it('parses an HGETALL-shaped array reply, split across arbitrary chunk boundaries', async () => {
		const fields = ['last_sent_at', '1700000000000', 'sent_in_window', '3'];
		const whole = `*${fields.length}\r\n${fields.map((f) => `$${encoder.encode(f).length}\r\n${f}\r\n`).join('')}`;
		// Slice the frame at unaligned byte offsets — the parser must not assume a read() lands on a
		// RESP token boundary.
		const chunks = [whole.slice(0, 7), whole.slice(7, 22), whole.slice(22)];
		const reader = new RespReader(fakeSource(chunks));
		expect(await parseReply(reader)).toEqual(fields);
	});

	it('parses an empty array (HGETALL on a nonexistent key)', async () => {
		const reader = new RespReader(fakeSource(['*0\r\n']));
		expect(await parseReply(reader)).toEqual([]);
	});
});
