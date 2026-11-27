import { logger as defaultLogger, type LoggerClient } from '../../monitoring/logger/client';

// What every email client shares: the message shape, the `IEmailClient` contract, and
// `BaseEmailClient`, which owns the sender and the log-and-return-false `send`. A transport
// (Workers `send_email` binding, SMTP, ...) only implements `deliver`.

export type EmailAttachment = { base64Data: string; contentType: string; filename: string };

export type Message = {
	attachments?: EmailAttachment[];
	/** Sender address for this message, overriding the client's `from`. */
	from?: string;
	/** Display name for this message, overriding the client's `fromName`. */
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

export type EmailSender = {
	/** Envelope and header sender. */
	from: string;
	/** Display name next to `from`. */
	fromName?: string;
	logger?: LoggerClient;
};

export abstract class BaseEmailClient implements IEmailClient {
	constructor(protected readonly sender: EmailSender) {}

	abstract deliver(input: Message): Promise<void>;

	async send(input: Message): Promise<boolean> {
		try {
			await this.deliver(input);
			return true;
		} catch (err) {
			await (this.sender.logger ?? defaultLogger).error(err, {
				from: this.fromFor(input),
				subject: input.subject,
				to: input.to,
			});
			return false;
		}
	}

	/** The sender address for one message: its own, else the client's. */
	protected fromFor(input: Message): string {
		return input.from ?? this.sender.from;
	}

	/** The display name for one message: its own, else the client's. */
	protected nameFor(input: Message): string | undefined {
		return input.fromName ?? this.sender.fromName;
	}
}
