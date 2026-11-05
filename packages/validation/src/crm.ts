import { z } from 'zod';
import {
  CRM_ACTIVITY_OUTCOMES,
  CRM_ACTIVITY_TYPES,
  CRM_COUNTRIES,
  CRM_LEAD_SOURCES,
  CRM_LIMITS,
  CRM_PRIORITIES,
  CRM_STAGES,
  CRM_TEAM_ROLES,
} from '@eticketsgo/shared-types';
import { ianaTimeZoneSchema } from './common';

/*
  Organizer acquisition (CRM) payloads. Shared by the API, which enforces them, and the admin
  console, which checks a form before sending it. Every text field is trimmed and capped: these
  rows are typed by people in a hurry and imported from spreadsheets.
*/

const text = (max: number) => z.string().trim().max(max);
/** '' clears an optional field; it is stored as null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/** A website as people type it: "example.com" is fine, "https://" is added for them. */
export const crmWebsiteSchema = z
  .string()
  .trim()
  .max(300)
  .transform((v) => (v === '' ? null : /^https?:\/\//i.test(v) ? v : `https://${v}`))
  .refine((v) => v === null || /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(v), {
    message: 'Enter a website such as example.com.',
  })
  .nullable()
  .optional();

export const crmEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .transform((v) => (v === '' ? null : v))
  .refine((v) => v === null || z.string().email().safeParse(v).success, {
    message: 'Enter a valid email address.',
  })
  .nullable()
  .optional();

/** Digits, spaces, dashes, brackets, dots and one leading +. At least 7 digits. */
export const crmPhoneSchema = z
  .string()
  .trim()
  .max(32)
  .transform((v) => (v === '' ? null : v))
  .refine((v) => v === null || (/^\+?[0-9 ()\-.]+$/.test(v) && v.replace(/\D/g, '').length >= 7), {
    message: 'Enter a phone number with at least 7 digits.',
  })
  .nullable()
  .optional();

const socialLink = z
  .string()
  .trim()
  .max(300)
  .refine((v) => /^https?:\/\/\S+$/i.test(v), { message: 'Each link must start with https://' });

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9 _-]*$/, 'Tags use letters, numbers, spaces, - and _.');

export const crmLeadFieldsSchema = z.object({
  organizationName: text(160).min(2, 'Enter the organization name.'),
  category: optionalText(80),
  website: crmWebsiteSchema,
  city: optionalText(80),
  state: optionalText(80),
  country: z.enum(CRM_COUNTRIES),
  timezone: ianaTimeZoneSchema.nullable().optional(),
  contactName: optionalText(120),
  contactTitle: optionalText(120),
  email: crmEmailSchema,
  phone: crmPhoneSchema,
  socialLinks: z.array(socialLink).max(5).optional(),
  source: z.enum(CRM_LEAD_SOURCES),
  priority: z.enum(CRM_PRIORITIES).optional(),
  notes: optionalText(4000),
  tags: z.array(tag).max(10).optional(),
});

export const crmCreateLeadSchema = crmLeadFieldsSchema.extend({
  teamId: z.string().min(1).max(64),
  /** Managers only. An agent's new lead is always assigned to the agent. */
  assignedToUserId: z.string().min(1).max(64).nullable().optional(),
  /** Create even though possible duplicates exist. Managers only. */
  confirmDuplicate: z.boolean().optional(),
});
export type CrmCreateLeadInput = z.infer<typeof crmCreateLeadSchema>;

/** Every field optional, plus the version the editor read (optimistic concurrency). */
export const crmUpdateLeadSchema = crmLeadFieldsSchema
  .omit({ country: true })
  .partial()
  .extend({ version: z.number().int().min(1) });
export type CrmUpdateLeadInput = z.infer<typeof crmUpdateLeadSchema>;

export const crmDuplicateCheckSchema = z.object({
  organizationName: text(160).optional(),
  website: crmWebsiteSchema,
  email: crmEmailSchema,
  phone: crmPhoneSchema,
  country: z.enum(CRM_COUNTRIES).optional(),
  /** Leave this lead out of the answer (editing it). */
  excludeLeadId: z.string().max(64).optional(),
});

const versioned = { version: z.number().int().min(1) };

export const crmAssignSchema = z.object({
  ...versioned,
  assignedToUserId: z.string().min(1).max(64).nullable(),
  note: optionalText(500),
});

export const crmStageSchema = z.object({
  ...versioned,
  stage: z.enum(CRM_STAGES),
  note: optionalText(1000),
  lostReason: optionalText(500),
});

export const crmArchiveSchema = z.object({ ...versioned, archived: z.boolean() });

export const crmLinkOrganizationSchema = z.object({
  ...versioned,
  organizationId: z.string().min(1).max(64),
});

export const crmUnlinkOrganizationSchema = z.object({ ...versioned });

const dateTimeInput = z.coerce.date();

export const crmFollowUpInputSchema = z.object({
  dueAt: dateTimeInput,
  title: text(200).min(2, 'Say what the follow-up is.'),
  notes: optionalText(2000),
  /** Managers may set it to any member of the lead's team; agents only to themselves. */
  ownerUserId: z.string().min(1).max(64).optional(),
});

export const crmActivitySchema = z.object({
  type: z.enum(CRM_ACTIVITY_TYPES),
  occurredAt: dateTimeInput,
  outcome: z.enum(CRM_ACTIVITY_OUTCOMES).nullable().optional(),
  notes: optionalText(4000),
  responsibleUserId: z.string().min(1).max(64).optional(),
  followUp: crmFollowUpInputSchema.optional(),
});
export type CrmActivityInput = z.infer<typeof crmActivitySchema>;

export const crmCompleteFollowUpSchema = z.object({ ...versioned, note: optionalText(1000) });
export const crmCancelFollowUpSchema = z.object({ ...versioned });
export const crmReassignFollowUpSchema = z.object({
  ...versioned,
  ownerUserId: z.string().min(1).max(64),
  dueAt: dateTimeInput.optional(),
});

const pageFields = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(CRM_LIMITS.pageSizeMax).default(25),
};
const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const crmLeadListQuerySchema = z.object({
  ...pageFields,
  q: text(120).optional(),
  stage: z.enum(CRM_STAGES).optional(),
  country: z.enum(CRM_COUNTRIES).optional(),
  city: text(80).optional(),
  teamId: z.string().max(64).optional(),
  /** A user id, "me" or "none" (unassigned). */
  assignee: z.string().max(64).optional(),
  source: z.enum(CRM_LEAD_SOURCES).optional(),
  priority: z.enum(CRM_PRIORITIES).optional(),
  tag: tag.optional(),
  followUp: z.enum(['overdue', 'upcoming', 'none']).optional(),
  archived: bool,
  linked: bool,
  sort: z
    .enum(['updated', 'created', 'name', 'nextFollowUp', 'stageAge'])
    .optional()
    .default('updated'),
});
export type CrmLeadListQuery = z.infer<typeof crmLeadListQuerySchema>;

export const crmFollowUpListQuerySchema = z.object({
  ...pageFields,
  status: z.enum(['OPEN', 'DONE', 'CANCELLED']).optional().default('OPEN'),
  when: z.enum(['overdue', 'today', 'upcoming', 'all']).optional().default('all'),
  /** A user id or "me". */
  owner: z.string().max(64).optional(),
  country: z.enum(CRM_COUNTRIES).optional(),
});

export const crmActivityListQuerySchema = z.object({
  ...pageFields,
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  type: z.enum(CRM_ACTIVITY_TYPES).optional(),
  /** A user id or "me". */
  user: z.string().max(64).optional(),
  country: z.enum(CRM_COUNTRIES).optional(),
  leadId: z.string().max(64).optional(),
});

export const crmReportQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  country: z.enum(CRM_COUNTRIES).optional(),
  city: text(80).optional(),
  assignee: z.string().max(64).optional(),
  source: z.enum(CRM_LEAD_SOURCES).optional(),
  stage: z.enum(CRM_STAGES).optional(),
  bucket: z.enum(['week', 'month']).optional().default('week'),
  format: z.enum(['json', 'csv']).optional().default('json'),
});
export type CrmReportQuery = z.infer<typeof crmReportQuerySchema>;

export const crmImportSchema = z.object({
  teamId: z.string().min(1).max(64),
  csv: z
    .string()
    .min(1, 'The file is empty.')
    .max(
      CRM_LIMITS.importCharsMax,
      `Import at most ${CRM_LIMITS.importCharsMax.toLocaleString('en-US')} characters at a time. Split the file.`,
    ),
  /** false: check the file and show what would happen. true: create the valid rows. */
  commit: z.boolean().default(false),
  /** What to do with a row that matches an existing lead. "create" is for managers only. */
  onDuplicate: z.enum(['skip', 'create']).default('skip'),
});

export const crmTeamMemberSchema = z.object({
  userId: z.string().min(1).max(64),
  role: z.enum(CRM_TEAM_ROLES),
});

export const crmCreateTeamSchema = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, 'Use 2-32 letters, numbers, - or _.'),
  name: text(80).min(2),
  country: z.enum(CRM_COUNTRIES),
});

export const crmOrganizationSearchSchema = z.object({ q: text(120).min(2) });
