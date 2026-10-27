import { z } from 'zod';
import { ORGANIZER_PURPOSES } from '../engagement/consent-purpose';
import { TEMPLATE_KEYS } from './campaign-content';
import { segmentDefinitionSchema } from './campaign-audience';
import { CampaignStatus } from './campaign-state';

const quietHours = z
  .object({ start: z.string().trim().max(5), end: z.string().trim().max(5) })
  .strict()
  .nullable();

const plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (s) => !/[\r\n\u0000-\u001F\u007F]/.test(s),
      'Use one line, with no hidden characters.',
    );

/** Content and audience are validated by the service, with messages a person can act on. */
export const draftSchema = z
  .object({
    name: plain(120).optional(),
    subject: plain(150).optional(),
    previewText: plain(200).nullable().optional(),
    senderName: plain(60).optional(),
    replyTo: z.string().trim().max(200).email().nullable().optional(),
    purpose: z.enum(ORGANIZER_PURPOSES).optional(),
    templateKey: z.enum(TEMPLATE_KEYS).optional(),
    content: z.unknown().optional(),
    eventId: z.string().trim().min(1).max(64).nullable().optional(),
    audience: z.unknown().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    quietHours: quietHours.optional(),
    locale: z.enum(['en', 'fr-CA']).optional(),
  })
  .strict();

export const updateSchema = draftSchema.extend({ version: z.number().int().min(1) }).strict();

export const versionSchema = z.object({ version: z.number().int().min(1) }).strict();

export const sendSchema = z
  .object({ version: z.number().int().min(1), confirmationToken: z.string().max(200) })
  .strict();

export const scheduleSchema = z
  .object({
    version: z.number().int().min(1),
    scheduledAt: z.string().datetime({ offset: true }),
    confirmationToken: z.string().max(200),
  })
  .strict();

export const rescheduleSchema = z
  .object({ version: z.number().int().min(1), scheduledAt: z.string().datetime({ offset: true }) })
  .strict();

export const testSendSchema = z
  .object({ to: z.array(z.string().trim().email().max(200)).min(1).max(5) })
  .strict();

export const audiencePreviewSchema = z
  .object({ audience: z.unknown(), purpose: z.enum(ORGANIZER_PURPOSES) })
  .strict();

export const segmentSchema = z
  .object({ name: plain(80), definition: segmentDefinitionSchema })
  .strict();

export const listSchema = z.object({
  status: z.enum(Object.values(CampaignStatus) as [string, ...string[]]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const statsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(30).optional(),
});

export const analyticsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  windowDays: z.coerce.number().int().min(1).max(30).optional(),
});

export const adminListSchema = z.object({
  status: z.enum(Object.values(CampaignStatus) as [string, ...string[]]).optional(),
  organizationId: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const adminPauseSchema = z.object({ reason: plain(300) }).strict();
