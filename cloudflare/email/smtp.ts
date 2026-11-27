import type { EnvStore } from '../../utils/env';

import { BaseEmailClient, type EmailSender, type Message } from './base';

// Email over SMTP (e.g. Amazon SES) with `worker-mailer`, which speaks SMTP over
// `cloudflare:sockets`: for sending to any recipient, where a `send_email` binding
// (`EmailClient`) can't. Same `IEmailClient` contract, so `DevEmailClient` and `FakeEmailClient`
// stand in for it too.

export type SmtpSettings = { host: string; password: string; port: number; username: string };

/** Connection options for worker-mailer: port 465 is implicit TLS, anything else STARTTLS. */
export function smtpConnection({ host, password, port, username }: SmtpSettings) {
	const implicitTls = port === 465;
	return {
		authType: 'plain' as const,
		credentials: { password, username },
		host,
		port,
		secure: implicitTls,
		startTls: !implicitTls,
	};
}

/** Settings are read from `env` when a message is delivered: the vars `SMTP_HOST`, `SMTP_PORT` and `SMTP_USERNAME`, and the secret `SES_SMTP_PASSWORD`. */
export class SmtpClient extends BaseEmailClient {
	constructor(
		private readonly env: EnvStore,
		sender: EmailSender
	) {
		super(sender);
	}

	async deliver(input: Message): Promise<void> {
		// Loaded lazily: it imports cloudflare:sockets, which only exists on Workers.
		const { WorkerMailer } = await import('worker-mailer');
		await WorkerMailer.send(smtpConnection(this.settings()), {
			attachments: input.attachments?.map((a) => ({
				content: a.base64Data,
				filename: a.filename,
				mimeType: a.contentType,
			})),
			from: { email: this.fromFor(input), name: this.nameFor(input) },
			html: input.html,
			reply: input.replyTo,
			subject: input.subject,
			text: input.text,
			to: input.to,
		});
	}

	private settings(): SmtpSettings {
		return {
			host: this.env.string('SMTP_HOST'),
			password: this.env.secret('SES_SMTP_PASSWORD'),
			port: this.env.int('SMTP_PORT'),
			username: this.env.string('SMTP_USERNAME'),
		};
	}
}
