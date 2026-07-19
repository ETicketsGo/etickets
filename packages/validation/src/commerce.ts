import { z } from 'zod';

// Experience Commerce CRUD schemas (v1.3). Money is integer minor units.

const ADD_ON_TYPES = [
  'MERCHANDISE',
  'PARKING',
  'FOOD_BEVERAGE',
  'VIP_UPGRADE',
  'MEET_GREET',
  'DONATION',
  'DIGITAL',
] as const;

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https?:\/\/.+/i.test(v), {
    message: 'Enter a valid URL starting with http:// or https://',
  })
  .optional();

export const createAddOnSchema = z
  .object({
    type: z.enum(ADD_ON_TYPES),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(1000).optional(),
    priceMinor: z.number().int().min(0),
    imageUrl: optionalUrl,
    maxPerOrder: z.number().int().min(1).max(50).default(10),
    // null / omitted = unlimited stock (donations, digital goods).
    quantityTotal: z.number().int().min(0).nullable().optional(),
    salesStartAt: z.coerce.date().nullable().optional(),
    salesEndAt: z.coerce.date().nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .refine((a) => !a.salesStartAt || !a.salesEndAt || a.salesEndAt >= a.salesStartAt, {
    message: 'End must be on or after start.',
    path: ['salesEndAt'],
  });

export const updateAddOnSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    priceMinor: z.number().int().min(0).optional(),
    imageUrl: optionalUrl,
    maxPerOrder: z.number().int().min(1).max(50).optional(),
    quantityTotal: z.number().int().min(0).nullable().optional(),
    salesStartAt: z.coerce.date().nullable().optional(),
    salesEndAt: z.coerce.date().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((a) => !a.salesStartAt || !a.salesEndAt || a.salesEndAt >= a.salesStartAt, {
    message: 'End must be on or after start.',
    path: ['salesEndAt'],
  });

export type CreateAddOnInput = z.infer<typeof createAddOnSchema>;
export type UpdateAddOnInput = z.infer<typeof updateAddOnSchema>;

const BUNDLE_TYPES = ['VIP', 'FAMILY', 'COMBO', 'EARLY_BIRD'] as const;

// A bundle component references exactly one of a ticket type or an add-on.
const bundleComponentSchema = z
  .object({
    ticketTypeId: z.string().cuid().optional(),
    addOnId: z.string().cuid().optional(),
    quantity: z.number().int().min(1).max(20),
  })
  .refine((c) => Boolean(c.ticketTypeId) !== Boolean(c.addOnId), {
    message: 'Each bundle item must reference exactly one ticket type or add-on.',
  });

const bundlePricingRefine = (b: {
  pricingKind: 'FIXED' | 'PERCENT_DISCOUNT';
  priceMinor?: number | null;
  discountPercent?: number | null;
}) =>
  b.pricingKind === 'FIXED'
    ? typeof b.priceMinor === 'number' && b.priceMinor >= 0
    : typeof b.discountPercent === 'number' && b.discountPercent >= 1 && b.discountPercent <= 100;

export const createBundleSchema = z
  .object({
    type: z.enum(BUNDLE_TYPES),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(1000).optional(),
    pricingKind: z.enum(['FIXED', 'PERCENT_DISCOUNT']),
    priceMinor: z.number().int().min(0).nullable().optional(),
    discountPercent: z.number().int().min(1).max(100).nullable().optional(),
    maxPerOrder: z.number().int().min(1).max(20).default(5),
    salesStartAt: z.coerce.date().nullable().optional(),
    salesEndAt: z.coerce.date().nullable().optional(),
    enabled: z.boolean().default(true),
    items: z.array(bundleComponentSchema).min(1, 'A bundle needs at least one item.').max(20),
  })
  .refine(bundlePricingRefine, {
    message: 'Set a fixed price (FIXED) or a discount percentage (PERCENT_DISCOUNT).',
    path: ['pricingKind'],
  })
  .refine((b) => !b.salesStartAt || !b.salesEndAt || b.salesEndAt >= b.salesStartAt, {
    message: 'End must be on or after start.',
    path: ['salesEndAt'],
  });

// Update keeps pricing coherent; components are replaced wholesale when provided.
export const updateBundleSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    pricingKind: z.enum(['FIXED', 'PERCENT_DISCOUNT']).optional(),
    priceMinor: z.number().int().min(0).nullable().optional(),
    discountPercent: z.number().int().min(1).max(100).nullable().optional(),
    maxPerOrder: z.number().int().min(1).max(20).optional(),
    salesStartAt: z.coerce.date().nullable().optional(),
    salesEndAt: z.coerce.date().nullable().optional(),
    enabled: z.boolean().optional(),
    items: z.array(bundleComponentSchema).min(1).max(20).optional(),
  })
  .refine((b) => !b.salesStartAt || !b.salesEndAt || b.salesEndAt >= b.salesStartAt, {
    message: 'End must be on or after start.',
    path: ['salesEndAt'],
  });

export type CreateBundleInput = z.infer<typeof createBundleSchema>;
export type UpdateBundleInput = z.infer<typeof updateBundleSchema>;
export type BundleComponentInput = z.infer<typeof bundleComponentSchema>;
