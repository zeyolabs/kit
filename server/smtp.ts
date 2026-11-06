import { envStore } from '../utils/env';

// Outbound mail over SMTP (e.g. Amazon SES) with `worker-mailer`, which speaks SMTP over
// `cloudflare:sockets`: for sending to arbitrary recipients, where the `send_email` binding
// (`cloudflare/email`) can't.

export type MailMessage = {
	from: { email: string; name?: string };
	html?: string;
	reply?: { email: string; name?: string };
	subject: string;
	text: string;
	to: string;
};

/** The names the SMTP settings go by in the app's wrangler config: three vars and one secret. */
export type SmtpKeys = { host: string; password: string; port: string; username: string };

/** Connection settings: port 465 is implicit TLS, anything else STARTTLS. */
export function smtpConnection(
	settings: { host: string; port: string; username: string },
	password: string
) {
	const port = Number(settings.port);
	const implicitTls = port === 465;
	return {
		authType: 'plain' as const,
		credentials: { password, username: settings.username },
		host: settings.host,
		port,
		secure: implicitTls,
		startTls: !implicitTls,
	};
}

/** Sends through SMTP, reading the settings named by `keys` from `envStore()` (so the password
 *  name must be among the context's `secretNames`). */
export async function sendSmtpMail(keys: SmtpKeys, message: MailMessage): Promise<void> {
	// Loaded lazily: it imports cloudflare:sockets, which only exists on Workers.
	const { WorkerMailer } = await import('worker-mailer');
	const store = envStore();
	const connection = smtpConnection(
		{
			host: store.string(keys.host),
			port: store.string(keys.port),
			username: store.string(keys.username),
		},
		store.secret(keys.password)
	);
	await WorkerMailer.send(connection, message);
}
