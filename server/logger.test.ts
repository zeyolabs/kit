import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoggerClient } from './logger';

vi.mock('@sentry/sveltekit', () => ({ captureException: vi.fn() }));

afterEach(() => {
	vi.restoreAllMocks();
});

describe('LoggerClient.info', () => {
	it('logs the message with an [INFO] prefix and the context', () => {
		const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
		new LoggerClient().info('order details edited', { order: 'PL-1' });
		expect(spy).toHaveBeenCalledWith('[INFO] order details edited', { order: 'PL-1' });
	});

	it('logs only the message when there is no context', () => {
		const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
		new LoggerClient().info('done');
		expect(spy).toHaveBeenCalledWith('[INFO] done');
	});
});
