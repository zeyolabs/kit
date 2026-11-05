import { describe, expect, it } from 'vitest';

import { type EmailParams, renderEmail, renderEmailText } from './email';

const params: EmailParams = {
	badge: 'Paid',
	brand: {
		accent: '#85b02b',
		accentDark: '#4a6a12',
		accentSoft: '#e2edb1',
		address: '1 Test Street, London',
		name: 'Test Shop',
		supportEmail: 'help@example.com',
	},
	cta: { href: 'https://example.com/delivery?a=1&b=2', label: 'Delivery info' },
	eyebrow: 'Order confirmation',
	heading: 'Thank you, <b>Sam</b>',
	intro: ['We have your order.'],
	preheader: 'Order PL-1 confirmed',
	sections: [
		{ rows: [{ label: 'Cup', strong: false, sub: '1 × £18.00', value: '£18.00' }] },
		{ lines: ['Sam Smith', '1 Test Street'], title: 'Delivering to' },
	],
};

describe('renderEmail', () => {
	const html = renderEmail(params);

	it('escapes dynamic text so a name cannot inject markup', () => {
		expect(html).not.toContain('<b>Sam</b>');
		expect(html).toContain('Thank you, &lt;b&gt;Sam&lt;/b&gt;');
	});

	it('escapes the call-to-action link', () => {
		expect(html).toContain('href="https://example.com/delivery?a=1&amp;b=2"');
	});

	it('includes the preheader, badge, rows, address block and footer', () => {
		expect(html).toContain('Order PL-1 confirmed');
		expect(html).toContain('>Paid<');
		expect(html).toContain('£18.00');
		expect(html).toContain('Delivering to');
		expect(html).toContain('help@example.com');
		expect(html).toContain('Test Shop, 1 Test Street, London');
	});

	it('uses only inline styles (no style blocks or classes)', () => {
		expect(html).not.toContain('<style');
		expect(html).not.toContain('class=');
	});
});

describe('renderEmailText', () => {
	it('mirrors the content as plain text', () => {
		const text = renderEmailText(params);
		expect(text).toContain('Cup (1 × £18.00): £18.00');
		expect(text).toContain('DELIVERING TO');
		expect(text).toContain('Sam Smith');
		expect(text).toContain('Delivery info: https://example.com/delivery?a=1&b=2');
	});
});
