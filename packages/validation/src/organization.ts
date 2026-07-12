import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { emailSchema } from './common';

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  contactEmail: emailSchema.optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum([Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF, Role.ORGANIZER_OWNER]),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const reviewDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().max(1000).optional(),
});
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;
