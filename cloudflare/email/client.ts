import { BaseMailClient, type MailClientOptions, type Message } from '../../email/base';
import { Mime } from './mime';

/** The shape of a Workers `send_email` binding. */
export type EmailBinding = { send(message: unknown): Promise<unknown> };

/** Sends transactional email over a Workers `send_email` binding (Cloudflare Email Routing).
 *  Use `DevMailClient` where there's no binding. */
export class CFMailClient extends BaseMailClient {
	private readonly binding: EmailBinding;

	constructor(config: MailClientOptions & { binding: EmailBinding }) {
		super(config);
		this.binding = config.binding;
	}

	async deliver(input: Message): Promise<void> {
		// Dynamic: `cloudflare:email` only resolves inside the Workers runtime.
		const { EmailMessage } = await import('cloudflare:email');
		await this.binding.send(new EmailMessage(input.from, input.to, Mime.build(input)));
	}
}
