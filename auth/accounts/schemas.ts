import { z } from 'zod';

import { Schema } from '../../utils/schema';

// Inputs of the account-management remote functions, shared with the app's forms (a remote module
// may only export remote functions).

const InviteSchema = z.object({
	email: Schema.Email,
	policy: z.string().min(1).max(40),
});

const PolicySchema = z.object({
	key: z.string().min(1).max(40),
	name: Schema.Text.max(60),
	permissions: z.array(z.string().max(80)).max(200),
});

/** The policy editor's form: unticking every permission sends none, so they default to `[]`. */
const PolicyFormSchema = PolicySchema.extend({
	key: z.string().trim().min(1, 'enter a key').max(40),
	permissions: PolicySchema.shape.permissions.default([]),
});

export const AccountSchemas = {
	Invite: InviteSchema,
	Policy: PolicySchema,
	PolicyForm: PolicyFormSchema,
};
