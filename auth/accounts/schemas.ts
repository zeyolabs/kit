import { z } from 'zod';

import { Schema } from '../../utils/schema';

// Inputs of the account-management remote functions, shared with the app's forms (a remote module
// may only export remote functions).

export const InviteSchema = z.object({
	email: Schema.Email,
	policy: z.string().min(1).max(40),
});

export const PolicySchema = z.object({
	key: z.string().min(1).max(40),
	name: z.string().trim().min(1).max(60),
	permissions: z.array(z.string().max(80)).max(200),
});
