import { z } from 'zod';
import { FeeMode } from '@eticketsgo/shared-types';

export const createVenueSchema = z.object({
  name: z.string().trim().min(2).max(160),
  city: z.string().trim().min(1).max(120),
  country: z.string().trim().min(2).max(120).default('India'),
  /**
   * IANA zone, e.g. "Asia/Kolkata". A start time means the time AT THE VENUE, so this is
   * what every showtime is rendered in. Validated against the runtime's own zone database
   * rather than a hand-maintained list — a list here would go stale and reject real zones.
   */
  timezone: z
    .string()
    .trim()
    .max(64)
    .refine(
      (tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Enter a valid IANA timezone, e.g. Asia/Kolkata.' },
    )
    .optional(),
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
  /**
   * Nobody pays anything for this event.
   *
   * A declaration by the organizer, not something read off the prices. If it were inferred
   * from "every ticket type is zero", an event would slip into and out of free as prices were
   * edited, and a booking taken under one reading could be confirmed under the other. Declared
   * once, it is a fact the booking, fee, payment and refund paths can all rely on — and the
   * API holds the two in agreement by refusing a priced ticket type on a free event.
   */
  isFree: z.boolean().default(false),
});
export type CreateEventInput = z.infer<typeof createEventSchema>;

export const createSessionSchema = z
  .object({
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    /**
     * The room this session happens in, when it happens in one with a seat map.
     *
     * Supplying it makes the session RESERVED SEATING: buyers choose named seats from the
     * room's published layout, and each ticket is bound to one. Omitting it leaves the
     * session general admission — buyers choose a quantity.
     *
     * A property of the room rather than of the kind of event: the same concert is reserved
     * seating in a theatre and general admission in a standing arena, which is why this sits
     * on the SESSION and not on the event.
     */
    screenId: z.string().cuid().optional(),
  })
  .refine((v) => v.endsAt > v.startsAt, {
    message: 'Session end must be after its start.',
    path: ['endsAt'],
  });
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

/**
 * Change, add or remove a session's room after it exists.
 *
 * `null` is a meaningful value and is why this is `nullable()` rather than `optional()`:
 * omitting the field and clearing the room are different intentions, and a schema that
 * cannot tell them apart makes "make this general admission again" unexpressible.
 */
export const updateSessionSeatingSchema = z.object({
  screenId: z.string().cuid().nullable(),
});
export type UpdateSessionSeatingInput = z.infer<typeof updateSessionSeatingSchema>;

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
