import { z } from 'zod';
import { ALL_ENTITLEMENT_KEYS } from '@eticketsgo/shared-types';

const reason = z.string().trim().min(3, 'Say why, in a few words.').max(500);
const planCode = z.enum(['PRO', 'PREMIUM']);
const optionalDate = z.coerce.date().nullable().optional();
const country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'A two-letter country code.')
  .transform((s) => s.toUpperCase());
const currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'A three-letter currency code.')
  .transform((s) => s.toUpperCase());
const minor = z.number().int().min(0).max(100_000_000);

export const loadCatalogSchema = z.object({
  annualFreeMonths: z.number().int().min(0).max(11).optional(),
});

export const updatePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one thing.');

export const entitlementValueSchema = z.object({
  key: z.enum(ALL_ENTITLEMENT_KEYS as [string, ...string[]]),
  boolValue: z.boolean().nullable().optional(),
  intValue: z.number().int().min(0).max(10_000_000).nullable().optional(),
});

export const setPlanEntitlementsSchema = z.object({
  entitlements: z.array(entitlementValueSchema).max(50),
});

export const createPriceSchema = z.object({
  planId: z.string().min(1),
  country,
  currency,
  interval: z.enum(['MONTH', 'YEAR']),
  amountMinor: minor,
  trialDays: z.number().int().min(0).max(365).nullable().optional(),
  providerPriceRefTest: z.string().trim().max(200).nullable().optional(),
  providerPriceRefLive: z.string().trim().max(200).nullable().optional(),
});

export const updatePriceSchema = z
  .object({
    amountMinor: minor.optional(),
    trialDays: z.number().int().min(0).max(365).nullable().optional(),
    providerPriceRefTest: z.string().trim().max(200).nullable().optional(),
    providerPriceRefLive: z.string().trim().max(200).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one thing.');

export const subscriptionSearchSchema = z.object({
  status: z
    .enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCELLED', 'EXPIRED', 'COMPLIMENTARY'])
    .optional(),
  planCode: z.enum(['FREE', 'PRO', 'PREMIUM']).optional(),
  country: z.string().trim().max(2).optional(),
  search: z.string().trim().max(120).optional(),
  currentOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v !== 'false'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const grantTrialSchema = z.object({
  planCode,
  days: z.number().int().min(1).max(90),
  reason,
});

export const grantComplimentarySchema = z.object({
  planCode,
  endsAt: optionalDate,
  reason,
});

export const endGrantSchema = z.object({ reason });

export const grantCreditsSchema = z.object({
  amount: z.number().int().min(1).max(1_000_000),
  reason,
  /** The console sends one per form submission, so a double click grants once. */
  idempotencyKey: z.string().trim().min(8).max(100),
});

export const recordDiscountSchema = z.object({
  percentOffBps: z.number().int().min(1).max(10_000).nullable().optional(),
  amountMinor: z.number().int().min(1).max(100_000_000).nullable().optional(),
  endsAt: optionalDate,
  reason,
});

export const grantOverrideSchema = z.object({
  key: z.enum(ALL_ENTITLEMENT_KEYS as [string, ...string[]]),
  boolValue: z.boolean().nullable().optional(),
  intValue: z.number().int().min(0).max(10_000_000).nullable().optional(),
  startsAt: optionalDate,
  endsAt: optionalDate,
  reason,
});

export const revokeOverrideSchema = z.object({ reason });

export const metricsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(366).default(30),
});

export const checkoutSchema = z.object({ priceId: z.string().min(1) });
