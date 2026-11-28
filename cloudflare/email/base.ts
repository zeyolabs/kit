import { logger as defaultLogger, type LoggerClient } from '../../monitoring/logger/client';

// What every email client shares: the message shape, the `IEmailClient` contract, and
// `BaseEmailClient`, which owns the sender and the log-and-return-false `send`. A transport
// (Workers `send_email` binding, SMTP, ...) only implements `deliver`.

export type EmailAttachment = { base64Data: string; contentType: string; filename: string };

export type Message = {
	attachments?: EmailAttachment[];
	from: string;
	fromName?: string;
	html?: string;
	replyTo?: { email: string; name?: string };
	subject: string;
	/** Plain-text body (or alternative to `html`). Give at least one of the two. */
	text?: string;
	to: string;
};

export interface IEmailClient {
	/** Sends one message; throws on failure, for callers that retry (queue consumers). */
	deliver(input: Message): Promise<void>;
	/** Sends one message. Logs and returns `false` on failure instead of throwing. */
	send(input: Message): Promise<boolean>;
}

export type EmailClientOptions = { logger?: LoggerClient };

export abstract class BaseEmailClient implements IEmailClient {
	constructor(protected readonly options: EmailClientOptions = {}) {}

	abstract deliver(input: Message): Promise<void>;

	async send(input: Message): Promise<boolean> {
		try {
			await this.deliver(input);
			return true;
		} catch (err) {
			await (this.options.logger ?? defaultLogger).error(err, {
				from: input.from,
				subject: input.subject,
				to: input.to,
			});
			return false;
		}
	}
}
