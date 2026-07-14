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
    email: z.string().trim().toLowerCase().email().optional(),
    subject: z.string().trim().max(160).optional(),
    message: z.string().trim().min(1).max(4000),
    rating: z.number().int().min(1).max(5).optional(),
    metadata: z.record(z.any()).optional(),
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
  });
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>;

/** Admin triage: filter the support inbox by kind and/or status, with search. */
export const listFeedbackSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  kind: z.nativeEnum(FeedbackKind).optional(),
  status: z.enum(['OPEN', 'TRIAGED', 'CLOSED']).optional(),
  q: z.string().trim().optional(),
});
export type ListFeedbackInput = z.infer<typeof listFeedbackSchema>;

/** Admin triage: move a submission through its OPEN → TRIAGED → CLOSED lifecycle. */
export const updateFeedbackSchema = z.object({
  status: z.enum(['OPEN', 'TRIAGED', 'CLOSED']),
});
export type UpdateFeedbackInput = z.infer<typeof updateFeedbackSchema>;
