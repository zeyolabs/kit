import { verifyTurnstile } from '../../server/turnstile';
import { envStore, type EnvStore } from '../../utils/env';

/** Cloudflare's dummy secret: verifies the test widget's tokens only. */
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

/** Cloudflare's dummy site key: the widget always passes. */
const TEST_SITE_KEY = '1x00000000000000000000AA';

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

export interface ITurnstileClient {
	/** The widget's site key for this host: the real one, or the test key on loopback. */
	siteKey(hostname: string, siteKey: string): string;
	/** True only when siteverify accepts the token. An empty token is false without a request. */
	verify(check: { hostname: string; ip: null | string; token: string }): Promise<boolean>;
}

/**
 * Cloudflare's Turnstile siteverify API. The widget's secret comes from the env store by name
 * (a Secrets Store binding in prod, `.dev.vars` locally). On loopback hosts the test key pair
 * stands in, so local dev needs no real widget.
 */
export class TurnstileClient implements ITurnstileClient {
	constructor(
		private readonly env: EnvStore,
		private readonly secretName: string
	) {}

	siteKey(hostname: string, siteKey: string): string {
		return LOOPBACK.test(hostname) ? TEST_SITE_KEY : siteKey;
	}

	async verify({
		hostname,
		ip,
		token,
	}: {
		hostname: string;
		ip: null | string;
		token: string;
	}): Promise<boolean> {
		if (!token) return false;
		const secret = LOOPBACK.test(hostname) ? TEST_SECRET_KEY : this.env.secret(this.secretName);
		return verifyTurnstile(token, ip, secret);
	}
}

/** Built fresh per call: the client holds no state beyond the secret's name. */
export function turnstile(secretName: string): TurnstileClient {
	return new TurnstileClient(envStore(), secretName);
}
