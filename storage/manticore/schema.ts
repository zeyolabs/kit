/** A Cloudflare socket (from a VPC Service `.connect()` or `cloudflare:sockets`): Web streams, not a
 *  Node duplex — the client bridges it to a `Duplex` before handing it to mysql2. */
export type CfSocket = {
	close?: () => Promise<void>;
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
};

/** Resolved Manticore connection config. Exactly one transport is set:
 *  - `socket` (prod): a thunk that opens the VPC Service TCP socket per connect. Resolving the binding
 *    lazily (not capturing it) keeps a reused client pointed at the ACTIVE request's binding.
 *  - `host`/`port` (dev): let mysql2 open its own TCP socket to the local Docker Manticore. */
export type ManticoreConfig = {
	/** Connect timeout (ms). */
	connectTimeoutMs?: number;
	/** Dev transport: mysql2 dials this directly. */
	host?: string;
	password: string;
	port?: number;
	/** Prod transport: open the VPC Service socket. Mutually exclusive with `host`/`port`. */
	socket?: () => Promise<CfSocket>;
	user: string;
};
