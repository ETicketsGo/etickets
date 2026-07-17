import { z } from 'zod';
import { FeeMode } from '@eticketsgo/shared-types';

export const createVenueSchema = z.object({
  name: z.string().trim().min(2).max(160),
  city: z.string().trim().min(1).max(120),
  country: z.string().trim().min(2).max(120).default('India'),
  address: z.string().trim().max(400).optional(),
  capacity: z.number().int().min(1).optional(),
});
export type CreateVenueInput = z.infer<typeof createVenueSchema>;

export const createEventSchema = z.object({
  title: z.string().trim().min(3).max(180),
  category: z.string().trim().min(2).max(80),
  description: z.string().trim().max(8000).optional(),
  venueId: z.string().cuid(),
  refundPolicy: z.string().trim().max(2000).optional(),
  feeMode: z.nativeEnum(FeeMode).default(FeeMode.CUSTOMER_PAYS),
});
export type CreateEventInput = z.infer<typeof createEventSchema>;

export const createSessionSchema = z
  .object({
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
  })
  .refine((v) => v.endsAt > v.startsAt, {
    message: 'Session end must be after its start.',
    path: ['endsAt'],
  });
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const createTicketTypeSchema = z.object({
  eventSessionId: z.string().cuid(),
  name: z.string().trim().min(1).max(120),
  /** Face value in minor units (paise). */
  priceMinor: z.number().int().min(0),
  currency: z.string().trim().length(3).default('INR'),
  quantityTotal: z.number().int().min(1),
  salesStartAt: z.coerce.date().optional(),
  salesEndAt: z.coerce.date().optional(),
  maxPerOrder: z.number().int().min(1).max(50).default(10),
});
export type CreateTicketTypeInput = z.infer<typeof createTicketTypeSchema>;

/** Partial ticket-type update. Server enforces sales-safety (price locked after
 *  first sale; quantity can only rise to cover committed inventory). */
export const updateTicketTypeSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  priceMinor: z.number().int().min(0).optional(),
  quantityTotal: z.number().int().min(1).optional(),
  salesStartAt: z.coerce.date().nullable().optional(),
  salesEndAt: z.coerce.date().nullable().optional(),
  maxPerOrder: z.number().int().min(1).max(50).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
export type UpdateTicketTypeInput = z.infer<typeof updateTicketTypeSchema>;
