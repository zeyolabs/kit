import { sha256 } from '@oslojs/crypto/sha2';
import { constantTimeEqual } from '@oslojs/crypto/subtle';
import { decodeHex, encodeHexLowerCase } from '@oslojs/encoding';

/** Small, dependency-free crypto primitives shared across every realm that mints or verifies a
 *  secret (order links, cron/webhook headers, …) — a plain object of pure functions, not a
 *  service: nothing here reads a binding or holds state. A `Crypto` helper, minus the
 *  token-at-rest `encrypt`/`decrypt` this project has no use for. */
export const Crypto = {
	/** sha256 of a secret, hex-encoded — what's actually stored (never the raw secret), so a
	 *  leaked DB row can't be replayed. Pair with `verifySecret` to check one back. */
	hashSecret(secret: string): string {
		return encodeHexLowerCase(sha256(new TextEncoder().encode(secret)));
	},

	/** A fresh, random, hex-encoded secret of `byteLength` bytes (defaults to 32 — 256 bits). */
	getRandomSecret(byteLength = 32): string {
		return encodeHexLowerCase(crypto.getRandomValues(new Uint8Array(byteLength)));
	},

	/** Constant-time string compare for secret-guarded routes/webhooks (a cron-secret header, a
	 *  webhook's clientState, …). Returns `false` (never throws) on a length mismatch, so this is
	 *  safe on arbitrary header/query input. */
	timingSafeEquals(a: string, b: string): boolean {
		const enc = new TextEncoder();
		return constantTimeEqual(enc.encode(a), enc.encode(b));
	},

	/** Constant-time check that `secret` hashes to `hash` (as produced by `hashSecret`) — never a
	 *  plain `===` on the derived hash, or a failed check's timing could leak how many leading
	 *  bytes matched. */
	verifySecret(secret: string, hash: string): boolean {
		const provided = sha256(new TextEncoder().encode(secret));
		return constantTimeEqual(provided, decodeHex(hash));
	},
};
