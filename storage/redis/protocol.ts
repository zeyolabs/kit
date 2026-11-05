// Hand-rolled RESP2 (Redis Serialization Protocol) codec — no Redis client runs on Workers (no
// Node `net`), same reasoning as `packages/core/server/mail/imap/client.ts`'s own hand-rolled
// IMAP parser over raw `cloudflare:sockets`. RESP2 is small enough (a handful of type-prefixed
// lines) that hand-rolling it is less risk than gambling on an npm client's socket-shim
// compatibility with the Workers runtime.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type RespValue = null | number | RespValue[] | string;

/** Matches `packages/core/server/mail/imap/protocol.ts`'s `ByteSource` shape — a thin seam over a
 *  `ReadableStreamDefaultReader<Uint8Array>` (real sockets) or a mock (tests). */
export type ByteSource = { read(): Promise<{ done: boolean; value?: Uint8Array }> };

/** Encode a command as a RESP2 array of bulk strings — the standard Redis request form
 *  (`*<argc>\r\n$<len>\r\n<bytes>\r\n...`). Every arg is sent as a bulk string regardless of type;
 *  Redis itself is untyped on the wire. */
export function encodeCommand(args: (number | string)[]): Uint8Array {
	const parts: Uint8Array[] = [encoder.encode(`*${args.length}\r\n`)];
	for (const arg of args) {
		const bytes = encoder.encode(String(arg));
		parts.push(encoder.encode(`$${bytes.length}\r\n`), bytes, encoder.encode('\r\n'));
	}
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** Buffers raw bytes off a `ByteSource` and slices out RESP frames (a line, or an exact-length
 *  bulk payload) without decoding anything it doesn't have to — a bulk string's `$<len>` is a BYTE
 *  length, so this must stay byte-buffered rather than accumulating a JS string (which the IMAP
 *  reader can get away with, since IMAP literals are ASCII-length-prefixed text). */
export class RespReader {
	private buf = new Uint8Array(0);
	private offset = 0;

	constructor(private readonly source: ByteSource) {}

	/** Read exactly `n` bytes, then discard the trailing CRLF a RESP bulk string always carries. */
	async readExact(n: number): Promise<Uint8Array> {
		while (this.buf.length - this.offset < n + 2) {
			if (!(await this.fill())) throw new Error('Redis connection closed unexpectedly (mid-bulk)');
		}
		const bytes = this.buf.subarray(this.offset, this.offset + n);
		this.offset += n + 2;
		return bytes;
	}

	/** Read one CRLF-terminated line, without the CRLF. */
	async readLine(): Promise<Uint8Array> {
		for (;;) {
			const idx = this.indexOfCrlf();
			if (idx !== -1) {
				const line = this.buf.subarray(this.offset, idx);
				this.offset = idx + 2;
				return line;
			}
			if (!(await this.fill())) throw new Error('Redis connection closed unexpectedly');
		}
	}

	private async fill(): Promise<boolean> {
		const { done, value } = await this.source.read();
		if (done) return false;
		if (value && value.length > 0) {
			const merged = new Uint8Array(this.buf.length - this.offset + value.length);
			merged.set(this.buf.subarray(this.offset));
			merged.set(value, this.buf.length - this.offset);
			this.buf = merged;
			this.offset = 0;
		}
		return true;
	}

	private indexOfCrlf(): number {
		for (let i = this.offset; i < this.buf.length - 1; i++) {
			if (this.buf[i] === 13 && this.buf[i + 1] === 10) return i;
		}
		return -1;
	}
}

/** Parse one RESP2 reply — recurses for `*` (array). A `-` (error) reply throws rather than
 *  returning, since every caller needs to treat a Redis-level error as a failure, not a value to
 *  branch on. */
export async function parseReply(reader: RespReader): Promise<RespValue> {
	const line = await reader.readLine();
	const type = line[0];
	const rest = decoder.decode(line.subarray(1));
	switch (type) {
		case 0x2b: // '+' simple string
			return rest;
		case 0x2d: // '-' error
			throw new Error(`Redis error: ${rest}`);
		case 0x3a: // ':' integer
			return Number(rest);
		case 0x24: {
			// '$' bulk string
			const len = Number(rest);
			if (len === -1) return null;
			return decoder.decode(await reader.readExact(len));
		}
		case 0x2a: {
			// '*' array
			const count = Number(rest);
			if (count === -1) return null;
			const items: RespValue[] = [];
			for (let i = 0; i < count; i++) items.push(await parseReply(reader));
			return items;
		}
		default:
			throw new Error(`Redis protocol error: unexpected reply type ${String.fromCharCode(type)}`);
	}
}
