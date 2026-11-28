import type { EmailAttachment, Message } from '../../email/base';

const CRLF = '\r\n';
const encoder = new TextEncoder();
// An RFC 2047 encoded-word is at most 75 chars; `=?UTF-8?B?` + `?=` leaves 63 base64 chars, 45 bytes.
const ENCODED_WORD_BYTES = 45;

type Part = { body: string; headers: string[] };

function base64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

const wrapLines = (b64: string) =>
	b64
		.replace(/\s/g, '')
		.match(/.{1,76}/g)
		?.join(CRLF) ?? '';

const isPrintableAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

// A CR or LF in a header value would start a new header: header injection.
const singleLine = (value: string) => value.replace(/[\r\n]+/g, ' ');

function encodedWords(value: string): string {
	const words: string[] = [];
	let chunk: number[] = [];
	for (const char of value) {
		const bytes = encoder.encode(char);
		if (chunk.length + bytes.length > ENCODED_WORD_BYTES) {
			words.push(`=?UTF-8?B?${base64(Uint8Array.from(chunk))}?=`);
			chunk = [];
		}
		chunk.push(...bytes);
	}
	if (chunk.length) words.push(`=?UTF-8?B?${base64(Uint8Array.from(chunk))}?=`);
	return words.join(`${CRLF} `);
}

function headerText(value: string): string {
	const line = singleLine(value);
	return isPrintableAscii(line) ? line : encodedWords(line);
}

function address(email: string, name?: string): string {
	const addr = singleLine(email);
	if (!name) return addr;
	const display = singleLine(name);
	return isPrintableAscii(display)
		? `"${display.replace(/["\\]/g, '\\$&')}" <${addr}>`
		: `${encodedWords(display)} <${addr}>`;
}

function filenameParams(filename: string): string {
	const name = singleLine(filename);
	return isPrintableAscii(name)
		? `filename="${name.replace(/["\\]/g, '\\$&')}"`
		: `filename*=UTF-8''${encodeURIComponent(name)}`;
}

const textPart = (contentType: string, content: string): Part => ({
	body: wrapLines(base64(encoder.encode(content))),
	headers: [`Content-Type: ${contentType}; charset=UTF-8`, 'Content-Transfer-Encoding: base64'],
});

const attachmentPart = ({ base64Data, contentType, filename }: EmailAttachment): Part => ({
	body: wrapLines(base64Data),
	headers: [
		`Content-Type: ${singleLine(contentType)}`,
		'Content-Transfer-Encoding: base64',
		`Content-Disposition: attachment; ${filenameParams(filename)}`,
	],
});

function multipart(subtype: 'alternative' | 'mixed', parts: Part[]): Part {
	// Base64 never contains `_`, so the boundary can't occur inside a part.
	const boundary = `=_${crypto.randomUUID()}`;
	const body = parts
		.map((part) => `--${boundary}${CRLF}${part.headers.join(CRLF)}${CRLF}${CRLF}${part.body}`)
		.join(CRLF);
	return {
		body: `${body}${CRLF}--${boundary}--`,
		headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
	};
}

export const Mime = {
	/** The raw RFC 5322 message a `send_email` binding's `EmailMessage` takes. */
	build(input: Message): string {
		const bodies = [
			...(input.text !== undefined ? [textPart('text/plain', input.text)] : []),
			...(input.html !== undefined ? [textPart('text/html', input.html)] : []),
		];
		const content =
			bodies.length === 0
				? textPart('text/plain', '')
				: bodies.length === 1
					? bodies[0]!
					: multipart('alternative', bodies);
		const attachments = (input.attachments ?? []).map(attachmentPart);
		const root = attachments.length ? multipart('mixed', [content, ...attachments]) : content;
		const domain = input.from.split('@')[1] ?? 'localhost';

		const headers = [
			`From: ${address(input.from, input.fromName)}`,
			`To: ${address(input.to)}`,
			...(input.replyTo ? [`Reply-To: ${address(input.replyTo.email, input.replyTo.name)}`] : []),
			`Subject: ${headerText(input.subject)}`,
			`Date: ${new Date().toUTCString()}`,
			`Message-ID: <${crypto.randomUUID()}@${singleLine(domain)}>`,
			'MIME-Version: 1.0',
			...root.headers,
		];
		return `${headers.join(CRLF)}${CRLF}${CRLF}${root.body}${CRLF}`;
	},
};
