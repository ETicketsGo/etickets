import { z } from 'zod';
import { Role } from '@eticketsgo/shared-types';
import { emailSchema, passwordSchema, registrableEmailSchema } from './common';

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
  /**
   * The accent palette this organization's workspace is rendered in.
   *
   * An enum, not free text, and that is the point: a colour nobody checked is an
   * accessibility regression waiting for one organization to find. Every palette named here
   * has its contrast pairs verified by the design system's own build, in light and dark, so
   * the set of things this field can say is exactly the set of things that are legible.
   *
   * '' clears it back to the platform default, matching every other field on this form.
   */
  consoleTheme: z
    .union([z.enum(['default', 'violet', 'emerald', 'amber', 'rose', 'slate']), z.literal('')])
    .optional(),
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
  email: registrableEmailSchema,
  role: z.enum([Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF, Role.ORGANIZER_OWNER]),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

/**
 * Accepting a team invitation.
 *
 * Both fields are optional because the two kinds of invitee need different things. Somebody
 * who already had an account keeps the password they know and supplies neither; somebody the
 * invite created has no usable credential and must choose one. Which case applies is the
 * SERVER's judgement, not the client's — it is derived from the account, and the server
 * refuses a missing password when one is genuinely required.
 */
export const acceptInvitationSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  password: passwordSchema.optional(),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const reviewDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().max(1000).optional(),
  /*
    Approve despite a missing legal identity, deliberately and on the record.

    An absolute requirement with no way past it strands the honest case the platform has not
    thought of yet — a market whose registration type nobody has encoded, an organizer whose
    paperwork is genuinely in a different form. So the gate holds by default and a reviewer
    can step over it by saying so, which is audited with the reason.

    Requiring the reason is the point. An override with an optional justification is a
    checkbox somebody ticks; one that will not proceed without a sentence is a decision.
  */
  overrideIdentityCheck: z.object({ reason: z.string().trim().min(10).max(500) }).optional(),
});
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;
