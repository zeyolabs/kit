import type { EmailInput, IEmailClient } from './base';

/** Stands in for a real client where there's no transport (local dev): logs instead of sending,
 *  so the message is still visible. */
export class DevEmailClient implements IEmailClient {
	async deliver({ subject, text, to }: EmailInput): Promise<void> {
		console.log(`[email:dev] to=${to} subject=${subject}${text ? `\n${text}` : ''}`);
	}

	async send(input: EmailInput): Promise<boolean> {
		await this.deliver(input);
		return true;
	}
}
