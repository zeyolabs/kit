/** A Cloudflare socket (from a VPC Service `.connect()` or `cloudflare:sockets`'s `connect()`):
 *  Web streams, the same shape either way — see `packages/core/server/mail/imap/client.ts` for
 *  the same technique against a different wire protocol. */
export type CfSocket = {
	close(): Promise<void>;
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
};

/** Resolved Redis connection config — `vpc`'s `.connect()` opens a raw socket to Redis's `:6379`
 *  listener. The caller reads it off its own `EnvStore` (`env.vpc('REDIS_VPC')`), not a binding
 *  name for this client to look up itself. Same shape as `ManticoreConfig`'s `vpc` field. */
export type RedisConfig = {
	password: string;
	user: string;
	vpc: Fetcher;
};
