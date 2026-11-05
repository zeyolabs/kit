const PROTOCOL_HEADER = new Uint8Array([0x41, 0x4d, 0x51, 0x50, 0, 0, 9, 1]);
const FRAME_END = 0xce;
const FRAME_TYPE_METHOD = 1;
const FRAME_TYPE_HEADER = 2;
const FRAME_TYPE_BODY = 3;

const CLASS_CONNECTION = 10;
const CLASS_CHANNEL = 20;
const CLASS_BASIC = 60;

type MethodFrame = { args: Uint8Array; channelId: number; classId: number; methodId: number };

class ByteWriter {
	private chunks: number[] = [];

	build(): Uint8Array {
		return new Uint8Array(this.chunks);
	}

	bytes(b: Uint8Array): this {
		for (const byte of b) this.chunks.push(byte);
		return this;
	}

	emptyTable(): this {
		this.long(0);
		return this;
	}

	long(v: number): this {
		this.chunks.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
		return this;
	}

	longlong(v: number): this {
		this.long(0);
		this.long(v);
		return this;
	}

	longstr(bytes: Uint8Array): this {
		this.long(bytes.length);
		this.bytes(bytes);
		return this;
	}

	octet(v: number): this {
		this.chunks.push(v & 0xff);
		return this;
	}

	short(v: number): this {
		this.chunks.push((v >>> 8) & 0xff, v & 0xff);
		return this;
	}

	shortstr(s: string): this {
		const bytes = new TextEncoder().encode(s);
		this.octet(bytes.length);
		this.bytes(bytes);
		return this;
	}
}

class ByteReader {
	private buf = new Uint8Array(0);

	constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

	async readExact(n: number): Promise<Uint8Array> {
		while (this.buf.length < n) {
			const { done, value } = await this.reader.read();
			if (done) throw new Error(`AMQP: connection closed while expecting ${n} bytes`);
			const merged = new Uint8Array(this.buf.length + value.length);
			merged.set(this.buf, 0);
			merged.set(value, this.buf.length);
			this.buf = merged;
		}
		const out = this.buf.slice(0, n);
		this.buf = this.buf.slice(n);
		return out;
	}
}

function u16(b: Uint8Array, offset: number): number {
	return (b[offset] << 8) | b[offset + 1];
}

function u32(b: Uint8Array, offset: number): number {
	return ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0;
}

async function writeFrame(
	writer: WritableStreamDefaultWriter<Uint8Array>,
	type: number,
	channelId: number,
	payload: Uint8Array
): Promise<void> {
	const header = new ByteWriter().octet(type).short(channelId).long(payload.length).build();
	await writer.write(header);
	await writer.write(payload);
	await writer.write(new Uint8Array([FRAME_END]));
}

async function readFrame(
	reader: ByteReader
): Promise<{ channelId: number; payload: Uint8Array; type: number }> {
	const header = await reader.readExact(7);
	const type = header[0];
	const channelId = u16(header, 1);
	const size = u32(header, 3);
	const payload = await reader.readExact(size);
	const trailer = await reader.readExact(1);
	if (trailer[0] !== FRAME_END) {
		throw new Error(
			`AMQP: malformed frame (expected 0xCE trailer, got 0x${trailer[0].toString(16)})`
		);
	}
	return { channelId, payload, type };
}

async function readMethodFrame(reader: ByteReader): Promise<MethodFrame> {
	const frame = await readFrame(reader);
	if (frame.type !== FRAME_TYPE_METHOD) {
		throw new Error(`AMQP: expected a method frame, got frame type ${frame.type}`);
	}
	return {
		args: frame.payload.slice(4),
		channelId: frame.channelId,
		classId: u16(frame.payload, 0),
		methodId: u16(frame.payload, 2),
	};
}

function parseConnectionClose(args: Uint8Array): { replyCode: number; replyText: string } {
	const replyCode = u16(args, 0);
	const textLen = args[2];
	const replyText = new TextDecoder().decode(args.slice(3, 3 + textLen));
	return { replyCode, replyText };
}

export type AmqpSocket = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
};

export type AmqpConfig = {
	password: string;
	username: string;
	vpc: { connect(address: string): AmqpSocket };
};

export interface IAmqpClient {
	publishJson(queue: string, body: unknown): Promise<void>;
}

export class AmqpClient implements IAmqpClient {
	constructor(private readonly config: AmqpConfig) {}

	async publishJson(queue: string, body: unknown): Promise<void> {
		const { password, username, vpc } = this.config;
		const socket = vpc.connect('127.0.0.1:5672');
		const writer = socket.writable.getWriter();
		const reader = new ByteReader(socket.readable.getReader());

		try {
			await writer.write(PROTOCOL_HEADER);

			const start = await readMethodFrame(reader);
			if (start.classId !== CLASS_CONNECTION || start.methodId !== 10) {
				throw new Error(
					`AMQP: expected Connection.Start, got class ${start.classId} method ${start.methodId}`
				);
			}

			const saslResponse = new TextEncoder().encode(`\0${username}\0${password}`);
			const startOk = new ByteWriter()
				.short(CLASS_CONNECTION)
				.short(11)
				.emptyTable()
				.shortstr('PLAIN')
				.longstr(saslResponse)
				.shortstr('en_US')
				.build();
			await writeFrame(writer, FRAME_TYPE_METHOD, 0, startOk);

			const tune = await readMethodFrame(reader);
			if (tune.classId !== CLASS_CONNECTION || tune.methodId !== 30) {
				throw new Error(
					`AMQP: expected Connection.Tune, got class ${tune.classId} method ${tune.methodId}`
				);
			}
			const channelMax = u16(tune.args, 0);
			const frameMax = u32(tune.args, 2);

			const tuneOk = new ByteWriter()
				.short(CLASS_CONNECTION)
				.short(31)
				.short(channelMax)
				.long(frameMax)
				.short(0)
				.build();
			await writeFrame(writer, FRAME_TYPE_METHOD, 0, tuneOk);

			const open = new ByteWriter()
				.short(CLASS_CONNECTION)
				.short(40)
				.shortstr('/')
				.shortstr('')
				.octet(0)
				.build();
			await writeFrame(writer, FRAME_TYPE_METHOD, 0, open);

			const openOk = await readMethodFrame(reader);
			if (openOk.classId !== CLASS_CONNECTION || openOk.methodId !== 41) {
				if (openOk.classId === CLASS_CONNECTION && openOk.methodId === 50) {
					const { replyCode, replyText } = parseConnectionClose(openOk.args);
					throw new Error(`AMQP: connection rejected (${replyCode}): ${replyText}`);
				}
				throw new Error(
					`AMQP: expected Connection.OpenOk, got class ${openOk.classId} method ${openOk.methodId}`
				);
			}

			const channelOpen = new ByteWriter().short(CLASS_CHANNEL).short(10).shortstr('').build();
			await writeFrame(writer, FRAME_TYPE_METHOD, 1, channelOpen);
			const channelOpenOk = await readMethodFrame(reader);
			if (channelOpenOk.classId !== CLASS_CHANNEL || channelOpenOk.methodId !== 11) {
				throw new Error(
					`AMQP: expected Channel.OpenOk, got class ${channelOpenOk.classId} method ${channelOpenOk.methodId}`
				);
			}

			const publish = new ByteWriter()
				.short(CLASS_BASIC)
				.short(40)
				.short(0)
				.shortstr('')
				.shortstr(queue)
				.octet(0)
				.build();
			await writeFrame(writer, FRAME_TYPE_METHOD, 1, publish);

			const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
			const header = new ByteWriter()
				.short(CLASS_BASIC)
				.short(0)
				.longlong(bodyBytes.length)
				.short(0x9000)
				.shortstr('application/json')
				.octet(2)
				.build();
			await writeFrame(writer, FRAME_TYPE_HEADER, 1, header);

			await writeFrame(writer, FRAME_TYPE_BODY, 1, bodyBytes);

			const close = new ByteWriter()
				.short(CLASS_CONNECTION)
				.short(50)
				.short(200)
				.shortstr('')
				.short(0)
				.short(0)
				.build();
			await writeFrame(writer, FRAME_TYPE_METHOD, 0, close);
			const closeOk = await readMethodFrame(reader);
			if (closeOk.classId !== CLASS_CONNECTION || closeOk.methodId !== 51) {
				throw new Error(
					`AMQP: expected Connection.CloseOk, got class ${closeOk.classId} method ${closeOk.methodId}`
				);
			}
		} finally {
			await writer.close().catch(() => {});
		}
	}
}
