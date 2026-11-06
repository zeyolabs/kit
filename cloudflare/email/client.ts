import { createMimeMessage } from 'mimetext/browser';

import { BaseEmailClient, type EmailInput, type EmailSender } from './base';

export {
	BaseEmailClient,
	type EmailAttachment,
	type EmailInput,
	type EmailSender,
	type IEmailClient,
} from './base';

/** The shape of a Workers `send_email` binding. */
export type EmailBinding = { send(message: unknown): Promise<unknown> };

function buildRawEmail(from: string, fromName: string | undefined, input: EmailInput): string {
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
 *  Use `DevEmailClient` where there's no binding. */
export class EmailClient extends BaseEmailClient {
	private readonly binding: EmailBinding;

	constructor(config: EmailSender & { binding: EmailBinding }) {
		super(config);
		this.binding = config.binding;
	}

	async deliver(input: EmailInput): Promise<void> {
		const { from } = this.sender;
		// Dynamic: `cloudflare:email` only resolves inside the Workers runtime.
		const { EmailMessage } = await import('cloudflare:email');
		const raw = buildRawEmail(from, this.nameFor(input), input);
		await this.binding.send(new EmailMessage(from, input.to, raw));
	}
}
