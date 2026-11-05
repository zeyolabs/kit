import { createMimeMessage } from 'mimetext/browser';

import { logger as defaultLogger, type LoggerClient } from '../../monitoring/logger/client';

export type EmailAttachment = { base64Data: string; contentType: string; filename: string };

export type EmailInput = {
	attachments?: EmailAttachment[];
	html: string;
	subject: string;
	to: string;
};

/** The shape of a Workers `send_email` binding. */
export type EmailBinding = { send(message: unknown): Promise<unknown> };

export interface IEmailClient {
	/** Sends one message. Logs and returns `false` on failure instead of throwing. */
	send(input: EmailInput): Promise<boolean>;
}

function buildRawEmail(
	from: string,
	fromName: string | undefined,
	{ attachments, html, subject, to }: EmailInput
): string {
	const msg = createMimeMessage();
	msg.setSender(fromName ? { addr: from, name: fromName } : { addr: from });
	msg.setRecipient(to);
	msg.setSubject(subject);
	msg.addMessage({ contentType: 'text/html', data: html });
	for (const attachment of attachments ?? []) {
		msg.addAttachment({
			contentType: attachment.contentType,
			data: attachment.base64Data,
			filename: attachment.filename,
		});
	}
	return msg.asRaw();
}

/** Sends transactional email over a Workers `send_email` binding (Cloudflare Email Routing).
 *  Use `DevEmailClient` where there's no binding. */
export class EmailClient implements IEmailClient {
	constructor(
		private readonly config: {
			binding: EmailBinding;
			/** Envelope and header sender. */
			from: string;
			/** Display name next to `from`. */
			fromName?: string;
			logger?: LoggerClient;
		}
	) {}

	/** Like `send`, but throws on failure — for callers that retry (queue consumers). */
	async deliver(input: EmailInput): Promise<void> {
		const { binding, from, fromName } = this.config;
		// Dynamic: `cloudflare:email` only resolves inside the Workers runtime.
		const { EmailMessage } = await import('cloudflare:email');
		await binding.send(new EmailMessage(from, input.to, buildRawEmail(from, fromName, input)));
	}

	async send(input: EmailInput): Promise<boolean> {
		try {
			await this.deliver(input);
			return true;
		} catch (err) {
			await (this.config.logger ?? defaultLogger).error(err, {
				from: this.config.from,
				subject: input.subject,
				to: input.to,
			});
			return false;
		}
	}
}
