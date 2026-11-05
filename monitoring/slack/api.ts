// Generic Slack Web API + Events API primitives — no app domain knowledge. `SlackClient`
// (./client.ts) is the separate Incoming-Webhook poster; this file is the bot-token
// (`chat.postMessage`) side plus request-signature verification.

/** Post a message (or thread reply) to a Slack channel via the bot token. Returns the posted
 *  message's `ts`. */
export async function slackPostMessage(
	token: string,
	params: {
		blocks?: Record<string, unknown>[];
		channel: string;
		icon_url?: string;
		text: string;
		thread_ts?: string;
		username?: string;
	}
): Promise<{ channel: string; ts: string }> {
	const res = await fetch('https://slack.com/api/chat.postMessage', {
		body: JSON.stringify(params),
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		method: 'POST',
	});
	const data = (await res.json()) as { channel: string; error?: string; ok: boolean; ts: string };
	if (!data.ok) throw new Error(`Slack postMessage: ${data.error ?? 'unknown error'}`);
	return { channel: data.channel, ts: data.ts };
}

/**
 * Verify a Slack request signature (v0 scheme, HMAC-SHA256). Returns false when the timestamp
 * is stale (> 5 minutes) or the computed signature does not match.
 */
export async function verifySlackSignature(
	signingSecret: string,
	timestamp: string,
	rawBody: string,
	signature: string
): Promise<boolean> {
	// Guard against replay attacks.
	if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(signingSecret),
		{ hash: 'SHA-256', name: 'HMAC' },
		false,
		['sign']
	);
	const base = `v0:${timestamp}:${rawBody}`;
	const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return timingSafeEqual(signature, `v0=${hex}`);
}

// Web Crypto has no `timingSafeEqual` — compare every byte instead of short-circuiting on the
// first mismatch, so response timing can't leak how many signature bytes an attacker got right.
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
