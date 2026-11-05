import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:email', () => ({
	EmailMessage: class {
		constructor(
			readonly from: string,
			readonly to: string,
			readonly raw: string
		) {}
	},
}));

import { EmailClient } from './client';

type Sent = { from: string; raw: string; to: string };

const input = { html: '<p>Hello</p>', subject: 'Welcome', to: 'user@example.com' };

describe('EmailClient', () => {
	const send = vi.fn(async (_message: unknown) => undefined);
	const log = { error: vi.fn(async () => undefined) };
	const client = () =>
		new EmailClient({ binding: { send }, from: 'noreply@example.com', logger: log as never });
	const lastSent = () => send.mock.calls.at(-1)![0] as Sent;

	beforeEach(() => {
		send.mockClear();
		log.error.mockClear();
	});

	it('sends a MIME message from the configured address to the recipient', async () => {
		await expect(client().send(input)).resolves.toBe(true);
		const { from, raw, to } = lastSent();
		expect(from).toBe('noreply@example.com');
		expect(to).toBe('user@example.com');
		// mimetext RFC 2047-encodes the subject (base64 of "Welcome"), so match either form.
		expect(raw).toMatch(/Subject: (Welcome|=\?utf-8\?B\?V2VsY29tZQ==\?=)/);
		expect(raw).toContain('text/html');
	});

	it('attaches files by name', async () => {
		await client().send({
			...input,
			attachments: [{ base64Data: 'aGk=', contentType: 'text/plain', filename: 'note.txt' }],
		});
		expect(lastSent().raw).toContain('note.txt');
	});

	it('logs and returns false when the binding throws', async () => {
		send.mockRejectedValueOnce(new Error('routing down'));
		await expect(client().send(input)).resolves.toBe(false);
		expect(log.error).toHaveBeenCalledTimes(1);
	});

	it('deliver throws on failure so queue consumers can retry', async () => {
		send.mockRejectedValueOnce(new Error('routing down'));
		await expect(client().deliver(input)).rejects.toThrow('routing down');
	});
});
