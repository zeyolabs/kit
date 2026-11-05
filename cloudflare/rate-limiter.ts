// RateLimiter Durable Object.
// Sliding-window limiter over DO storage. Handles both the single-window form (rate-limit
// categories: {limit, window}) and the multi-window form ({windows: [[limit, secs]...]}).
// Allowed only when every window has budget; one timestamp is recorded against all of them.
// Host it in a standalone worker (see workers/rate-limiter) and bind it with `script_name`.
import { DurableObject } from 'cloudflare:workers';

type RateLimitRequest = {
	category: string;
	limit?: number;
	userId: string;
	window?: number;
	windows?: [number, number][];
};

export class RateLimiter extends DurableObject {
	async fetch(req: Request): Promise<Response> {
		const body = await req.json<RateLimitRequest>();

		// Normalise both request forms to a list of [limit, windowSeconds].
		const windows: [number, number][] =
			body.windows && body.windows.length > 0
				? body.windows
				: [[body.limit ?? 0, body.window ?? 0]];

		const key = `${body.userId}:${body.category}`;
		const stored = (await this.ctx.storage.get<number[]>(key)) ?? [];

		const now = Date.now();
		// Drop timestamps older than the largest window: they can't count toward any window.
		const maxWindow = Math.max(...windows.map(([, secs]) => secs));
		const cutoff = now - maxWindow * 1000;
		const valid = stored.filter((ts) => ts > cutoff);

		// Deny, recording nothing, if any single window is already at its limit.
		for (const [limit, secs] of windows) {
			const start = now - secs * 1000;
			const inWindow = valid.filter((ts) => ts > start);
			if (inWindow.length >= limit) {
				const oldest = Math.min(...inWindow);
				const resetAt = oldest + secs * 1000;
				const retryAfter = Math.ceil((resetAt - now) / 1000);
				return Response.json(
					{ allowed: false, remaining: 0, resetAt, retryAfter },
					{ status: 429 }
				);
			}
		}

		valid.push(now);
		await this.ctx.storage.put(key, valid);

		// Report remaining/reset for the tightest window.
		const remaining = Math.max(
			0,
			Math.min(
				...windows.map(
					([limit, secs]) => limit - valid.filter((ts) => ts > now - secs * 1000).length
				)
			)
		);
		const soonest = Math.min(...windows.map(([, secs]) => secs));
		return Response.json({ allowed: true, remaining, resetAt: now + soonest * 1000 });
	}
}
