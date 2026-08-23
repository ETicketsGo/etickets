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

/** Optional trimmed text that also accepts '' to clear the field. */
const clearableText = (max: number) => z.string().trim().max(max).optional();

/**
 * The seller's legal and tax identity — everything an invoice has to name.
 *
 * ── WHAT IS DELIBERATELY NOT VALIDATED HERE ───────────────────────────────────────────
 * The registration NUMBER is checked for length and character set and nothing else. It is
 * tempting to enforce, say, the 15-character GSTIN pattern, and that would be a mistake:
 * this field has to hold a GSTIN, a US EIN, a Canadian GST/HST number and whatever the next
 * market uses, each with its own format, each subject to change by an authority that does
 * not consult this repository. A regex here would reject valid identifiers and would have to
 * be corrected in a release. Format checking belongs to the tax authority; the platform's
 * job is to record faithfully what the organizer tells it and print it on the document.
 *
 * `taxRegistrationKind` is free text for the same reason — it LABELS the number ("GSTIN",
 * "EIN", "GST/HST") so a reader knows what they are looking at, and an enum here would mean
 * shipping code to enter a new market.
 */
export const updateOrganizationLegalIdentitySchema = z.object({
  legalName: clearableText(200),
  taxRegistrationKind: clearableText(40),
  taxRegistrationNumber: z
    .string()
    .trim()
    .max(64)
    .refine((v) => v === '' || /^[A-Za-z0-9][A-Za-z0-9 \-/]*$/.test(v), {
      message: 'Use letters, digits, spaces, hyphens or slashes only.',
    })
    .optional(),
  registeredAddressLine1: clearableText(200),
  registeredAddressLine2: clearableText(200),
  registeredCity: clearableText(120),
  registeredRegion: clearableText(120),
  registeredPostalCode: clearableText(20),
  registeredCountry: clearableText(120),
  financeContactName: clearableText(160),
  financeContactEmail: z.union([emailSchema, z.literal('')]).optional(),
  financeContactPhone: clearableText(40),
});
export type UpdateOrganizationLegalIdentityInput = z.infer<
  typeof updateOrganizationLegalIdentitySchema
>;

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
