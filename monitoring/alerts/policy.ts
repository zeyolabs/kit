import { z } from 'zod';

import { Schema } from '../../utils/schema';

/** A policy's recipients are unverified addresses the account types in, so the count is bounded. */
export const MAX_POLICY_RECIPIENTS = 10;

/** Each webhook is an outbound request per fired event, so the count is bounded. */
export const MAX_POLICY_WEBHOOKS = 5;

/** Saved webhook destinations per account. */
export const MAX_ACCOUNT_WEBHOOKS = 20;

/** Scalars and string lists, so it fits a `<Form>`'s input type; the service validates it against the config schema of the policy's alert type. */
export const PolicyConfig = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
);

/** `description: null` clears it; omitted fields are left as they are, and `recipients`/`webhookIds` replace the destinations only when given. */
export const UpdatePolicySchema = z.object({
	config: PolicyConfig.optional(),
	description: Schema.Text.max(280).nullable().optional(),
	enabled: z.boolean().optional(),
	id: Schema.UUID,
	name: Schema.Text.max(80).optional(),
	recipients: z.array(Schema.Email).max(MAX_POLICY_RECIPIENTS).optional(),
	webhookIds: z.array(z.number().int()).max(MAX_POLICY_WEBHOOKS).optional(),
});
export type UpdatePolicySchema = z.infer<typeof UpdatePolicySchema>;

export const PolicyIdSchema = z.object({ id: Schema.UUID });
export type PolicyIdSchema = z.infer<typeof PolicyIdSchema>;

export const HistoryPageQuerySchema = z.object({
	limit: z.number().int().min(1).max(100).default(20),
	offset: z.number().int().min(0).default(0),
});
export type HistoryPageQuerySchema = z.infer<typeof HistoryPageQuerySchema>;
