import { z } from 'zod';

import type { LoggerClient } from '../logger/client';
import type { EventKey, EventRegistry } from './registry';

/** Structural shape of the alerts queue binding — kept minimal so this doesn't pull in a
 *  Cloudflare Workers type kit doesn't already depend on. */
export type AlertsQueueBinding = { send(body: unknown): Promise<void> };

/**
 * Fires alert events onto a queue binding, generic over the caller's own event registry `R` —
 * kit has no notion of what an alert type is called. `fire` warns and returns instead of throwing
 * when the binding is absent — this is what lets the binding roll out app-by-app without every
 * caller needing a feature-flag check first. Once the binding exists, a failed enqueue IS a real
 * error (the caller believed the alert would fire and it silently wouldn't), so that case logs
 * and rethrows instead of being swallowed.
 */
export class Alert<R extends EventRegistry> {
	constructor(
		private readonly queue: AlertsQueueBinding | undefined,
		private readonly logger: LoggerClient,
		private readonly registry: R
	) {}

	/** `accountId` is the envelope the consumer scopes by, not part of what happened — so it's its
	 *  own argument rather than something every producer has to remember to put in the payload.
	 *  The payload is encoded to its wire form here, so an invalid one throws instead of being
	 *  dropped by the consumer. */
	async fire<K extends EventKey<R>>(
		accountId: number,
		event: K,
		payload: z.output<R[K]['payload']>
	): Promise<void> {
		if (!this.queue) {
			this.logger.warn('alerts queue binding not configured — dropping alert event', { event });
			return;
		}

		try {
			const encoded = z.encode(this.registry[event].payload, payload);
			// eslint-disable-next-line perfectionist/sort-objects -- key order is the serialized wire order
			await this.queue.send({ event, payload: encoded, accountId });
		} catch (err) {
			this.logger.error(err, { accountId, event, op: 'alertFire' });
			throw err;
		}
	}
}
