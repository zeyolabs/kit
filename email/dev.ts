import type { IMailClient, Message } from './base';

/** Stands in for a real client where there's no transport (local dev): logs instead of sending,
 *  so the message is still visible. */
export class DevMailClient implements IMailClient {
	async deliver({ subject, text, to }: Message): Promise<void> {
		console.log(`[email:dev] to=${to} subject=${subject}${text ? `\n${text}` : ''}`);
	}

	async send(input: Message): Promise<boolean> {
		await this.deliver(input);
		return true;
	}
}
