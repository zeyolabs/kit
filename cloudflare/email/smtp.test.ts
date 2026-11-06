import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('worker-mailer', () => ({ WorkerMailer: { send } }));

import { SmtpClient, smtpConnection } from './smtp';

const settings = { host: 'smtp.example.com', password: 'pw', port: 587, username: 'user' };
const log = { error: vi.fn(async () => undefined) };
const client = () =>
	new SmtpClient({
		...settings,
		from: 'noreply@example.com',
		fromName: 'Example',
		logger: log as never,
	});

beforeEach(() => {
	send.mockClear();
	log.error.mockClear();
});

describe('smtpConnection', () => {
	it('uses STARTTLS on 587 and implicit TLS on 465', () => {
		expect(smtpConnection(settings)).toMatchObject({
			credentials: { password: 'pw', username: 'user' },
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			startTls: true,
		});
		expect(smtpConnection({ ...settings, port: 465 })).toMatchObject({
			secure: true,
			startTls: false,
		});
	});
});

describe('SmtpClient', () => {
	it('sends from the configured sender, with per-message name and reply-to', async () => {
		await expect(
			client().send({
				fromName: 'Example website',
				html: '<p>Hi</p>',
				replyTo: { email: 'ada@example.com' },
				subject: 'Hello',
				text: 'Hi',
				to: 'bob@example.com',
			})
		).resolves.toBe(true);
		const [connection, message] = send.mock.calls[0];
		expect(connection).toMatchObject({ host: 'smtp.example.com', port: 587 });
		expect(message).toMatchObject({
			from: { email: 'noreply@example.com', name: 'Example website' },
			html: '<p>Hi</p>',
			reply: { email: 'ada@example.com' },
			subject: 'Hello',
			text: 'Hi',
			to: 'bob@example.com',
		});
	});

	it('falls back to the client display name', async () => {
		await client().send({ subject: 's', text: 't', to: 'bob@example.com' });
		expect(send.mock.calls[0][1]).toMatchObject({ from: { name: 'Example' } });
	});

	it('logs and returns false on failure; deliver throws', async () => {
		send.mockRejectedValueOnce(new Error('auth failed'));
		await expect(client().send({ subject: 's', text: 't', to: 'x@example.com' })).resolves.toBe(
			false
		);
		expect(log.error).toHaveBeenCalledOnce();
		send.mockRejectedValueOnce(new Error('auth failed'));
		await expect(
			client().deliver({ subject: 's', text: 't', to: 'x@example.com' })
		).rejects.toThrow('auth failed');
	});
});
