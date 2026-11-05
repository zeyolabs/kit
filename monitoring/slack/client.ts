import type { EnvStore } from '../../utils/env';

import { logger } from '../logger/client';

/**
 * Posts a message to a Slack channel via an incoming webhook. Never throws on a failed post —
 * losing an alert must not fail the caller's actual work — but a webhook request failure (network,
 * non-2xx) is still logged.
 */
export class SlackClient {
	constructor(private readonly webhookUrl: string) {}

	/** `blocks` is optional, for a richer message than plain `text`. */
	async post(payload: { blocks?: Record<string, unknown>[]; text: string }): Promise<boolean> {
		try {
			const res = await fetch(this.webhookUrl, {
				body: JSON.stringify(payload),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			if (!res.ok) throw new Error(`Slack webhook responded ${res.status}`);
			return true;
		} catch (err) {
			await logger.error(err, { alert: payload.text });
			return false;
		}
	}
}

/** Built from `SLACK_OPS_WEBHOOK_URL` off the ambient env store. */
export function slackClient(env: EnvStore): SlackClient {
	return new SlackClient(env.string('SLACK_OPS_WEBHOOK_URL'));
}
