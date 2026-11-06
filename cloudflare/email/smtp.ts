import { envStore } from '../../utils/env';
import { BaseEmailClient, type EmailInput, type EmailSender } from './base';

// Email over SMTP (e.g. Amazon SES) with `worker-mailer`, which speaks SMTP over
// `cloudflare:sockets`: for sending to any recipient, where a `send_email` binding
// (`EmailClient`) can't. Same `IEmailClient` contract, so `DevEmailClient` and `FakeEmailClient`
// stand in for it too.

export type SmtpSettings = { host: string; password: string; port: number; username: string };

/** The wrangler names of the SMTP settings: three vars and one Secrets Store secret. */
export type SmtpKeys = { host: string; password: string; port: string; username: string };

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

export class SmtpClient extends BaseEmailClient {
	private readonly settings: SmtpSettings;

	constructor(config: EmailSender & SmtpSettings) {
		super(config);
		this.settings = config;
	}

	/** A client whose settings come from `envStore()` under the names in `keys` (so the password's
	 *  name must be among the request context's `secretNames`). */
	static fromEnv(keys: SmtpKeys, sender: EmailSender): SmtpClient {
		const store = envStore();
		return new SmtpClient({
			...sender,
			host: store.string(keys.host),
			password: store.secret(keys.password),
			port: store.int(keys.port),
			username: store.string(keys.username),
		});
	}

	async deliver(input: EmailInput): Promise<void> {
		// Loaded lazily: it imports cloudflare:sockets, which only exists on Workers.
		const { WorkerMailer } = await import('worker-mailer');
		await WorkerMailer.send(smtpConnection(this.settings), {
			attachments: input.attachments?.map((a) => ({
				content: a.base64Data,
				filename: a.filename,
				mimeType: a.contentType,
			})),
			from: { email: this.sender.from, name: this.nameFor(input) },
			html: input.html,
			reply: input.replyTo,
			subject: input.subject,
			text: input.text,
			to: input.to,
		});
	}
}
