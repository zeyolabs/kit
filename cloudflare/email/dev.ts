import type { EmailInput, IEmailClient } from './client';

/** Stands in for `EmailClient` where there's no `send_email` binding (local dev) — logs instead of
 *  sending, so the message is still visible. */
export class DevEmailClient implements IEmailClient {
	async send({ subject, to }: EmailInput): Promise<boolean> {
		console.log(`[email:dev] to=${to} subject=${subject}`);
		return true;
	}
}
