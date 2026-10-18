import { z } from 'zod';
import { FeedbackKind } from '@eticketsgo/shared-types';

/**
 * A customer-success submission: contact/bug/feature/general free-form messages
 * plus CSAT/ORGANIZER_CSAT satisfaction ratings. CSAT kinds require a `rating`;
 * a CONTACT submission requires an email when the sender is anonymous (the
 * controller supplies the authenticated user's email, so signed-in users omit it).
 */
export const submitFeedbackSchema = z
  .object({
    kind: z.nativeEnum(FeedbackKind),
    // 254 is the longest address SMTP can carry; this one becomes the Reply-To of a mail.
    email: z.string().trim().toLowerCase().max(254).email().optional(),
    /*
      What the sender calls themselves, for the support mailbox's "From" line. Optional, and
      only ever shown as text: a signed-in sender's account name is used when this is absent.
    */
    name: z.string().trim().max(120).optional(),
    /*
      The language the form was shown in, so the acknowledgement is written in it. Free text
      rather than an enum so an older or newer client is never refused over it; the API reads
      only the locales it has a catalogue for and treats anything else as English.
    */
    locale: z.string().trim().max(16).optional(),
    subject: z.string().trim().max(160).optional(),
    message: z.string().trim().min(1).max(4000),
    rating: z.number().int().min(1).max(5).optional(),
    metadata: z.record(z.any()).optional(),
    /*
      The booking a complaint is about, where there is one.

      The ORGANIZER is never accepted from the client. It is derived from this booking on the
      server, so nobody can file a complaint against a seller they never bought from - and a
      complaint count an admin acts on cannot be stuffed by a stranger.
    */
    bookingId: z.string().trim().min(1).max(64).optional(),
  })
  .superRefine((val, ctx) => {
    if (
      (val.kind === FeedbackKind.CSAT || val.kind === FeedbackKind.ORGANIZER_CSAT) &&
      val.rating == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rating'],
        message: 'A rating from 1 to 5 is required for satisfaction surveys.',
      });
    }
    // A complaint nobody can be answered at is a complaint the platform has failed to handle.
    if (val.kind === FeedbackKind.COMPLAINT && !val.email && !val.bookingId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['email'],
        message: 'Tell us how to reach you, or say which booking this is about.',
      });
    }
  });
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>;

/** Admin triage: filter the support inbox by kind and/or status, with search. */
export const listFeedbackSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  kind: z.nativeEnum(FeedbackKind).optional(),
  status: z.enum(['OPEN', 'TRIAGED', 'CLOSED']).optional(),
  q: z.string().trim().optional(),
  /** Narrow the inbox to one organizer - what somebody reviewing a seller needs. */
  organizationId: z.string().trim().min(1).max(64).optional(),
});
export type ListFeedbackInput = z.infer<typeof listFeedbackSchema>;

/** Admin triage: move a submission through its OPEN → TRIAGED → CLOSED lifecycle. */
export const updateFeedbackSchema = z.object({
  status: z.enum(['OPEN', 'TRIAGED', 'CLOSED']),
});
export type UpdateFeedbackInput = z.infer<typeof updateFeedbackSchema>;
