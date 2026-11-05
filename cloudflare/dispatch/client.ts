/** Structural shape of the dispatch queue binding — kept minimal so kit doesn't pull in a
 *  Cloudflare Workers type it doesn't already depend on. */
export type DispatchQueueBinding = { send(body: unknown): Promise<void> };

export interface IDispatchClient<M> {
	send(message: M): Promise<void>;
}

/**
 * Hands a message to the `dispatch` queue, generic over the caller's own message union `M` — kit
 * has no notion of what a dispatch type is called. Stamps `enqueuedAt` (unix seconds) on the way
 * out, which is the one envelope field every consumer relies on and no producer should have to
 * remember.
 */
export class DispatchClient<M extends { type: string }> implements IDispatchClient<M> {
	constructor(private readonly queue: DispatchQueueBinding) {}

	async send(message: M): Promise<void> {
		await this.queue.send({ ...message, enqueuedAt: Math.floor(Date.now() / 1000) });
	}
}

/** Used when no `DISPATCH_QUEUE` binding exists (local dev) — logs instead of delivering, so a
 *  missing binding degrades the same way `DevPrometheusClient` does rather than throwing. */
export class DevDispatchClient<M extends { type: string }> implements IDispatchClient<M> {
	async send(message: M): Promise<void> {
		console.info('[dispatch] no DISPATCH_QUEUE binding — dropping message', { type: message.type });
		return Promise.resolve();
	}
}
