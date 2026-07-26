import { z } from 'zod';

// ─── Stripe Connect onboarding (organizer self-service) ───

// Path param for organizer-scoped Connect routes. Organization ids are cuids.
export const organizerIdParamSchema = z.object({
  organizerId: z.string().cuid(),
});
export type OrganizerIdParam = z.infer<typeof organizerIdParamSchema>;

// Creating/linking a connected account. Country is ISO-3166 alpha-2; US-first.
export const createConnectAccountSchema = z.object({
  country: z.string().trim().toUpperCase().length(2).default('US'),
  // The organizer's business email (Stripe prefills onboarding with it). Optional.
  email: z.string().trim().toLowerCase().email().optional(),
});
export type CreateConnectAccountInput = z.infer<typeof createConnectAccountSchema>;

// ─── Stripe checkout (customer) ───

export const stripeCheckoutSchema = z.object({
  bookingId: z.string().cuid(),
});
export type StripeCheckoutInput = z.infer<typeof stripeCheckoutSchema>;

// ─── Razorpay Checkout verification (India) ───

export const razorpayVerifySchema = z.object({
  razorpay_order_id: z.string().trim().min(1),
  razorpay_payment_id: z.string().trim().min(1),
  razorpay_signature: z.string().trim().min(1),
});
export type RazorpayVerifyInput = z.infer<typeof razorpayVerifySchema>;

// ─── Admin settlement actions ───

// Approve carries no body beyond the id path param.
export const settlementBlockSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required.').max(500),
});
export type SettlementBlockInput = z.infer<typeof settlementBlockSchema>;

// Release is idempotent server-side; an optional note is recorded in the audit trail.
export const settlementReleaseSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type SettlementReleaseInput = z.infer<typeof settlementReleaseSchema>;

export const settlementListSchema = z.object({
  status: z
    .enum([
      'PENDING',
      'HELD',
      'ELIGIBLE',
      'APPROVED',
      'TRANSFER_PROCESSING',
      'TRANSFERRED',
      'PARTIALLY_REFUNDED',
      'BLOCKED',
      'FAILED',
      'REVERSED',
    ])
    .optional(),
  organizationId: z.string().cuid().optional(),
  eventId: z.string().cuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type SettlementListInput = z.infer<typeof settlementListSchema>;
