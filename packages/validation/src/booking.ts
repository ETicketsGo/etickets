import { z } from 'zod';

export const bookingItemSchema = z
  .object({
    ticketTypeId: z.string().cuid(),
    quantity: z.number().int().min(1).max(20),
    /** Seat-based (movie) bookings only: the specific seats for this line.
     *  When present, seatIds.length must equal quantity. */
    seatIds: z.array(z.string().cuid()).max(20).optional(),
  })
  .refine((v) => !v.seatIds || v.seatIds.length === v.quantity, {
    message: 'The number of selected seats must match the quantity.',
    path: ['seatIds'],
  });

// Experience Commerce lines (v1.3). Add-ons and bundles are optional; a booking
// still needs at least one line overall (ticket, add-on, or bundle).
export const addOnItemSchema = z.object({
  addOnId: z.string().cuid(),
  quantity: z.number().int().min(1).max(50),
});

export const bundleItemInputSchema = z.object({
  bundleId: z.string().cuid(),
  quantity: z.number().int().min(1).max(20),
});

export const createBookingSchema = z
  .object({
    eventSessionId: z.string().cuid(),
    items: z.array(bookingItemSchema).max(50).default([]),
    addOns: z.array(addOnItemSchema).max(50).optional(),
    bundles: z.array(bundleItemInputSchema).max(20).optional(),
    couponCode: z.string().trim().max(40).optional(),
    buyerName: z.string().trim().min(2).max(120),
    buyerEmail: z.string().email(),
  })
  .refine((v) => v.items.length + (v.addOns?.length ?? 0) + (v.bundles?.length ?? 0) >= 1, {
    message: 'Add at least one item to your cart.',
    path: ['items'],
  });
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const createPaymentSchema = z.object({
  bookingId: z.string().cuid(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const refundRequestSchema = z.object({
  bookingId: z.string().cuid(),
  reason: z.string().trim().min(3).max(500),
  ticketIds: z.array(z.string().cuid()).optional(),
});
export type RefundRequestInput = z.infer<typeof refundRequestSchema>;
