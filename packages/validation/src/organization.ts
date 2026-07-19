import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { emailSchema } from './common';

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  contactEmail: emailSchema.optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

// A trimmed, length-capped URL that also accepts '' (used to clear the field).
const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https?:\/\/.+/i.test(v), {
    message: 'Enter a valid URL starting with http:// or https://',
  })
  .optional();

// Public organizer profile (v1.2 WS6). Every field is optional; '' clears it.
export const updateOrganizationProfileSchema = z.object({
  description: z.string().trim().max(2000).optional(),
  logoUrl: optionalUrl,
  coverImageUrl: optionalUrl,
  website: optionalUrl,
  twitterUrl: optionalUrl,
  instagramUrl: optionalUrl,
  facebookUrl: optionalUrl,
  contactEmail: z.union([emailSchema, z.literal('')]).optional(),
  contactPhone: z.string().trim().max(40).optional(),
});
export type UpdateOrganizationProfileInput = z.infer<typeof updateOrganizationProfileSchema>;

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
