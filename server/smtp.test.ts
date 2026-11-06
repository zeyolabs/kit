import { describe, expect, it } from 'vitest';

import { smtpConnection } from './smtp';

const settings = { host: 'h', username: 'u' };

describe('smtpConnection', () => {
	it('uses STARTTLS on 587', () => {
		expect(smtpConnection({ ...settings, port: '587' }, 'p')).toMatchObject({
			credentials: { password: 'p', username: 'u' },
			host: 'h',
			port: 587,
			secure: false,
			startTls: true,
		});
	});

	it('uses implicit TLS on 465', () => {
		expect(smtpConnection({ ...settings, port: '465' }, 'p')).toMatchObject({
			port: 465,
			secure: true,
			startTls: false,
		});
	});
});
