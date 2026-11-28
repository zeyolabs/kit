import { createMimeMessage } from 'mimetext/browser';

import { BaseMailClient, type MailClientOptions, type Message } from '../../email/base';

/** The shape of a Workers `send_email` binding. */
export type EmailBinding = { send(message: unknown): Promise<unknown> };

function buildRawEmail(from: string, fromName: string | undefined, input: Message): string {
	const msg = createMimeMessage();
	msg.setSender(fromName ? { addr: from, name: fromName } : { addr: from });
	msg.setRecipient(input.to);
	msg.setSubject(input.subject);
	if (input.replyTo) msg.setHeader('Reply-To', input.replyTo.email);
	if (input.text) msg.addMessage({ contentType: 'text/plain', data: input.text });
	if (input.html) msg.addMessage({ contentType: 'text/html', data: input.html });
	for (const attachment of input.attachments ?? []) {
		msg.addAttachment({
			contentType: attachment.contentType,
			data: attachment.base64Data,
			filename: attachment.filename,
		});
	}
	return msg.asRaw();
}

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
		const raw = buildRawEmail(input.from, input.fromName, input);
		await this.binding.send(new EmailMessage(input.from, input.to, raw));
	}
}
