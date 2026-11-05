import { z } from 'zod';

export type FormResponseType = 'error' | 'ok' | 'warning';
export type FormResult<T> = {
	data: T;
	message?: string;
	type: FormResponseType;
};

/** Utility functions to return form responses */
export const FormResult = {
	/** Returns a form error with data and a message */
	errData<T>(info: { data: T; message?: string }): FormResult<T> {
		return {
			...info,
			type: 'error',
		};
	},

	/** Returns a form error with a message */
	err(message?: string): FormResult<void> {
		return {
			data: undefined,
			message,
			type: 'error',
		};
	},

	/** Returns a form warning with data and a message */
	warnData<T>(info: { data: T; message?: string }): FormResult<T> {
		return {
			...info,
			type: 'warning',
		};
	},

	/** Returns a form warning with a message */
	warn(message?: string): FormResult<void> {
		return {
			data: undefined,
			message,
			type: 'warning',
		};
	},

	/** Returns a form ok with data and a message */
	okData<T>(info: { data: T; message?: string }): FormResult<T> {
		return {
			...info,
			type: 'ok',
		};
	},

	/** Returns a form ok with a message */
	ok(message?: string): FormResult<void> {
		return {
			data: undefined,
			message,
			type: 'ok',
		};
	},
};

/**
 * Number field — parses string or number input to any finite number (unbounded).
 * Accepts numbers directly because `convert_formdata` parses `n:`-prefixed fields
 * via `parseFloat`, so preflight validation receives an already-parsed number.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const formInt = z.any().transform((input: any, ctx) => {
	if (input === undefined || (typeof input === 'string' && input.trim() === '')) {
		ctx.issues.push({
			code: 'invalid_type',
			expected: 'number',
			input,
			message: 'number is required',
		});
		return z.NEVER;
	}
	const n = typeof input === 'number' ? input : Number(input);
	if (!Number.isFinite(n)) {
		ctx.issues.push({
			code: 'invalid_type',
			expected: 'number',
			input,
			message: 'invalid number',
		});
		return z.NEVER;
	}
	return n;
}) as z.ZodType<number, number | string>;

/** `<Form>`/remote-function field primitives that genuinely depend on SvelteKit's FormData
 *  conversion conventions (`b:`/`n:`-prefixed field coercion, `RemoteFormInput`'s empty-string
 *  handling) — a plain object of schemas/functions (a Library, same pattern as `Crypto`/`Schema`
 *  in the kit), kept here rather than in `kit` because these aren't portable facts. */
export const SchemaForm = {
	/** Boolean field — SvelteKit converts `b:`-prefixed checkbox inputs to `boolean`; defaults to
	 *  `false` */
	Boolean: z
		.boolean()
		.optional()
		.transform((v) => v ?? false)
		.pipe(z.boolean()),

	Int: formInt,

	/** Number field — finite number bound to 0 or greater */
	Number: formInt.pipe(z.number().min(0, 'must be 0 or greater')),

	/**
	 * Wraps any string-or-number schema so an empty input becomes `null`.
	 * Usage: `SchemaForm.nullable(Schema.Text.min(3))`, `SchemaForm.nullable(SchemaForm.Number)`.
	 *
	 * Transport-agnostic at runtime — parses both a `<Form>` value (FormData: empty field = `''`)
	 * and a JSON body (absent/optional field = real `null` or `undefined`). All three (`''`, `null`,
	 * `undefined`) normalise to `null`; a value passes through to the wrapped schema. So the same
	 * helper can back a `<Form>` *and* a JSON API/command body for an optional scalar field.
	 *
	 * The declared **input type stays `number | string`** on purpose: `<Form>`'s `RemoteFormInput`
	 * forbids `null`/`undefined` field values, so widening the type would break form usage. `null`/
	 * `undefined` are accepted at runtime (the union below) without being exposed in the type —
	 * JSON parsing is runtime validation anyway, so the narrower type costs the JSON path nothing.
	 */
	nullable<T extends z.ZodType<unknown, number | string>>(schema: T) {
		return z
			.union([z.string(), z.number(), z.null(), z.undefined()])
			.transform((v): null | number | string => {
				// Empty form field (''), absent/empty n:-field (undefined), or JSON null → null.
				if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
				return v;
			})
			.pipe(schema.nullable()) as z.ZodType<null | z.infer<T>, number | string>;
	},
};
