import { z } from 'zod';

export const bookingItemSchema = z.object({
  ticketTypeId: z.string().cuid(),
  quantity: z.number().int().min(1).max(20),
});

export const createBookingSchema = z.object({
  eventSessionId: z.string().cuid(),
  items: z.array(bookingItemSchema).min(1, 'Select at least one ticket.'),
  couponCode: z.string().trim().max(40).optional(),
  buyerName: z.string().trim().min(2).max(120),
  buyerEmail: z.string().email(),
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
