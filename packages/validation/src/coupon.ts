import { z } from 'zod';

/** Discount code creation (organizer-scoped). Value is a percent (1–100) for
 *  PERCENT coupons or a fixed amount in minor units for FIXED coupons. */
export const createCouponSchema = z
  .object({
    organizationId: z.string().min(1),
    code: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphen or underscore only.'),
    type: z.enum(['PERCENT', 'FIXED']),
    value: z.number().int().positive(),
    maxRedemptions: z.number().int().positive().optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
  })
  .refine((c) => c.type !== 'PERCENT' || c.value <= 100, {
    message: 'A percentage discount must be between 1 and 100.',
    path: ['value'],
  })
  .refine((c) => !c.startsAt || !c.endsAt || c.endsAt >= c.startsAt, {
    message: 'End must be on or after start.',
    path: ['endsAt'],
  });

/** Partial update. Code and type are immutable (the code is what buyers type, the
 *  type changes the meaning of value); everything else is editable. */
export const updateCouponSchema = z
  .object({
    value: z.number().int().positive().optional(),
    maxRedemptions: z.number().int().positive().nullable().optional(),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((c) => !c.startsAt || !c.endsAt || c.endsAt >= c.startsAt, {
    message: 'End must be on or after start.',
    path: ['endsAt'],
  });

export type CreateCouponInput = z.infer<typeof createCouponSchema>;
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;
