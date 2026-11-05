import { defineConfig } from 'vitest/config';

// Integration tests that hit a real ClickHouse (gated on CLICKHOUSE_URL). Kept out of the unit
// glob so `pnpm test` stays offline; run explicitly with `pnpm test:integration`.
export default defineConfig({
	test: {
		environment: 'node',
		globals: true,
		include: ['**/*.integration.test.ts'],
		name: 'kit-integration',
		testTimeout: 60000,
	},
});
