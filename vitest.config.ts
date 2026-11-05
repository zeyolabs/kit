import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
		globals: true,
		include: ['**/*.test.ts'],
		name: 'kit',
		// tsc reports errors from every file; only the `.test-d.ts` type tests should fail the run.
		typecheck: { enabled: true, ignoreSourceErrors: true, include: ['**/*.test-d.ts'] },
	},
});
