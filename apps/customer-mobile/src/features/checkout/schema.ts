import { z } from 'zod';

/**
 * Runtime contract for the booking + payment endpoints.
 * Verified end-to-end against the QA API on 2026-08-04.
 */

const minor = z.number().int();

/** The API's own fee calculation. This — not any client arithmetic — is the total. */
export const feeBreakdownSchema = z.object({
  currency: z.string(),
  subtotalMinor: minor,
  discountMinor: minor,
  netSubtotalMinor: minor,
  bookingFeeMinor: minor,
  paymentFeeMinor: minor,
  /** What the customer pays on top of the tickets. Zero when the organizer absorbs it. */
  customerFeeMinor: minor,
  organizerFeeMinor: minor,
  /** The amount that will be charged. */
  totalMinor: minor,
});

export const createBookingResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  currency: z.string(),
  /** The hold deadline. Past this the seats go back and the booking dies. */
  holdExpiresAt: z.string().nullable(),
  fees: feeBreakdownSchema,
  payment: z.object({ id: z.string(), status: z.string() }).nullable().optional(),
});

/**
 * Response of POST /bookings/:id/pay.
 *
 * `clientActionUrl` is the entire provider-selection mechanism, and it points the other
 * way from how a payment SDK usually works: the server decides which provider handles
 * this booking — by country, by organizer's connected account, by outage failover — and
 * hands back one URL. The app follows it. It never inspects a provider name, never
 * holds a publishable key, and never has an opinion about Stripe versus Razorpay.
 *
 * Two shapes come back, and they are distinguished by the URL itself:
 *   - a RELATIVE path ("/api/payments/<id>/mock-pay") is an action on our own API
 *   - an ABSOLUTE https URL is a hosted provider page, opened in a browser
 *
 * A third shape exists, and it is still the server's choice, not the app's: for an
 * order paid through Razorpay the API returns an ORDER (`razorpay` below) rather than a
 * URL, because Razorpay checkout runs on the device, not on a hosted page. In that
 * response `clientActionUrl` is the order id, which is neither a path nor a URL. The app
 * opens the native checkout with exactly what the server sent and holds no key of its
 * own: `keyId` is Razorpay's PUBLIC key id, which is designed to be shipped to clients.
 */
export const razorpayOrderSchema = z.object({
  keyId: z.string().min(1),
  orderId: z.string().min(1),
  amountMinor: minor,
  currency: z.string(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  prefill: z
    .object({
      name: z.string().nullish(),
      email: z.string().nullish(),
      contact: z.string().nullish(),
    })
    .nullish(),
});

export const paymentIntentSchema = z.object({
  providerRef: z.string(),
  clientActionUrl: z.string().nullable(),
  status: z.string(),
  razorpay: razorpayOrderSchema.nullish(),
});

export type FeeBreakdown = z.infer<typeof feeBreakdownSchema>;
export type CreateBookingResponse = z.infer<typeof createBookingResponseSchema>;
export type PaymentIntent = z.infer<typeof paymentIntentSchema>;
export type RazorpayOrder = z.infer<typeof razorpayOrderSchema>;
