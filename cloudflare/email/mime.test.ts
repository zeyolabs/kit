import { describe, expect, it } from 'vitest';

import { Mime } from './mime';

const base = { from: 'noreply@example.com', subject: 'Welcome', to: 'user@example.com' };

const decode = (b64: string) =>
	new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

function parse(raw: string) {
	const [head = '', ...rest] = raw.split('\r\n\r\n');
	const headers = Object.fromEntries(
		head
			.replace(/\r\n /g, ' ')
			.split('\r\n')
			.map((line) => {
				const i = line.indexOf(':');
				return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
			})
	);
	return { body: rest.join('\r\n\r\n'), headers };
}

function partsOf(body: string, contentType: string) {
	const boundary = /boundary="([^"]+)"/.exec(contentType)?.[1];
	if (!boundary) throw new Error('no boundary');
	expect(body.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
	return body
		.split(`--${boundary}`)
		.slice(1, -1)
		.map((chunk) => parse(chunk.replace(/^\r\n/, '').replace(/\r\n$/, '')));
}

describe('Mime.build', () => {
	it('writes the envelope headers', () => {
		const { headers } = parse(Mime.build({ ...base, fromName: 'Shop', text: 'hi' }));
		expect(headers.from).toBe('"Shop" <noreply@example.com>');
		expect(headers.to).toBe('user@example.com');
		expect(headers.subject).toBe('Welcome');
		expect(headers['mime-version']).toBe('1.0');
		expect(headers['message-id']).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
		expect(Number.isNaN(Date.parse(headers.date))).toBe(false);
	});

	it('sends a single body as one part', () => {
		const { body, headers } = parse(Mime.build({ ...base, html: '<p>Hello</p>' }));
		expect(headers['content-type']).toBe('text/html; charset=UTF-8');
		expect(headers['content-transfer-encoding']).toBe('base64');
		expect(decode(body)).toBe('<p>Hello</p>');
	});

	it('sends text and html as alternatives', () => {
		const { body, headers } = parse(Mime.build({ ...base, html: '<p>Hi</p>', text: 'Hi' }));
		expect(headers['content-type']).toMatch(/^multipart\/alternative; boundary=/);
		const [text, html] = partsOf(body, headers['content-type']);
		expect(text?.headers['content-type']).toBe('text/plain; charset=UTF-8');
		expect(decode(text!.body)).toBe('Hi');
		expect(decode(html!.body)).toBe('<p>Hi</p>');
	});

	it('wraps bodies and attachments with the files after them', () => {
		const raw = Mime.build({
			...base,
			attachments: [{ base64Data: btoa('note'), contentType: 'text/plain', filename: 'note.txt' }],
			html: '<p>Hi</p>',
			text: 'Hi',
		});
		const { body, headers } = parse(raw);
		expect(headers['content-type']).toMatch(/^multipart\/mixed; boundary=/);
		const [content, file] = partsOf(body, headers['content-type']);
		expect(content?.headers['content-type']).toMatch(/^multipart\/alternative/);
		expect(file?.headers['content-disposition']).toBe('attachment; filename="note.txt"');
		expect(decode(file!.body)).toBe('note');
	});

	it('encodes non-ASCII subjects, names and filenames', () => {
		const subject = 'Café ☕ '.repeat(10);
		const raw = Mime.build({
			...base,
			attachments: [{ base64Data: btoa('x'), contentType: 'text/plain', filename: 'résumé.txt' }],
			fromName: 'Zoë',
			subject,
			text: 'Grüße',
		});
		expect(raw.split('\r\n').every((line) => line.length <= 998)).toBe(true);
		const { body, headers } = parse(raw);
		const words = [...headers.subject.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
		expect(words.every(([word]) => word.length <= 75)).toBe(true);
		expect(words.map(([, b64]) => decode(b64!)).join('')).toBe(subject);
		expect(headers.from).toBe(`=?UTF-8?B?${btoa('Zo\xc3\xab')}?= <noreply@example.com>`);
		const [text, file] = partsOf(body, headers['content-type']);
		expect(decode(text!.body)).toBe('Grüße');
		expect(file?.headers['content-disposition']).toBe(
			"attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt"
		);
	});

	it('keeps base64 lines at 76 chars', () => {
		const { body } = parse(Mime.build({ ...base, text: 'x'.repeat(500) }));
		expect(
			body
				.trimEnd()
				.split('\r\n')
				.every((line) => line.length <= 76)
		).toBe(true);
	});

	it('strips line breaks from header values', () => {
		const raw = Mime.build({ ...base, subject: 'Hi\r\nBcc: victim@example.com', text: 'x' });
		expect(raw).not.toMatch(/^Bcc:/m);
		expect(parse(raw).headers.subject).toBe('Hi Bcc: victim@example.com');
	});

	it('quotes a display name with quotes in it', () => {
		const { headers } = parse(Mime.build({ ...base, fromName: 'The "Best" Shop', text: 'x' }));
		expect(headers.from).toBe('"The \\"Best\\" Shop" <noreply@example.com>');
	});
});
