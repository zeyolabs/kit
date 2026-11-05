import { describe, expect, it } from 'vitest';

import { isPrivateAddress, isPublicHost } from './public-host';

describe('isPrivateAddress', () => {
	it('treats the edges of the private ranges correctly', () => {
		expect(isPrivateAddress('172.15.255.255')).toBe(false);
		expect(isPrivateAddress('172.32.0.0')).toBe(false);
		expect(isPrivateAddress('11.0.0.1')).toBe(false);
		expect(isPrivateAddress('100.128.0.1')).toBe(false);
		expect(isPrivateAddress('2606:4700::6810:84e5')).toBe(false);
		expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
		expect(isPrivateAddress('not-an-ip')).toBe(true);
	});
});

describe('isPublicHost', () => {
	it.each(['hooks.example.com', '93.184.216.34', '[2606:4700::6810:84e5]'])('allows %s', (host) => {
		expect(isPublicHost(host)).toBe(true);
	});

	it.each([
		'localhost',
		'api.localhost',
		'127.0.0.1',
		'10.0.0.5',
		'169.254.169.254',
		'[::1]',
		'[fd00:ec2::254]',
		'[::ffff:127.0.0.1]',
	])('rejects %s', (host) => {
		expect(isPublicHost(host)).toBe(false);
	});
});
