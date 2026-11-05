import { base, config } from './eslint-config.js';

export default config(
	...base(),
	// `typeof EVENTS` in a `satisfies` clause is a type-only use the rule can't see.
	{
		files: ['monitoring/alerts/event-config.test*.ts'],
		rules: { '@typescript-eslint/no-unused-vars': 'off' },
	},
	{
		languageOptions: {
			parserOptions: {
				tsconfigRootDir: import.meta.dirname,
			},
		},
	}
);
