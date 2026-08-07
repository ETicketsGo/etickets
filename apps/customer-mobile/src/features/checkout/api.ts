import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as Crypto from 'expo-crypto';
import { apiClient } from '@/services/api-client';
import { postParsed } from '@/services/http';
import { bookingKeys } from '@/features/bookings/api';
import {
  createBookingResponseSchema,
  paymentIntentSchema,
  type CreateBookingResponse,
  type PaymentIntent,
} from './schema';

export interface CartItem {
  ticketTypeId: string;
  quantity: number;
  /**
   * Reserved-seating lines only. The API's createBookingSchema enforces
   * seatIds.length === quantity, and a seat-based session will not accept a line
   * without them — general-admission lines must omit the field entirely rather than
   * send an empty array.
   */
  seatIds?: string[];
}

export interface CreateBookingArgs {
  eventSessionId: string;
  items: CartItem[];
  buyerName: string;
  buyerEmail: string;
  couponCode?: string;
}

/**
 * Create the booking and its inventory hold.
 *
 * The idempotency key is generated once per attempt and REUSED across retries, which is
 * the whole point: a request that times out on a flaky mobile connection has very
 * possibly succeeded server-side, and retrying with a fresh key would hold a second set
 * of seats and, after payment, charge twice. A phone loses its connection mid-request
 * often enough that this is a routine case, not an edge one.
 */
export function useCreateBooking() {
  const queryClient = useQueryClient();

  return useMutation<
    CreateBookingResponse,
    unknown,
    CreateBookingArgs & { idempotencyKey: string }
  >({
    mutationFn: async ({ idempotencyKey, ...body }) => {
      const { data } = await apiClient.post('/bookings', body, {
        headers: { 'idempotency-key': idempotencyKey },
      });
      const parsed = createBookingResponseSchema.safeParse(data);
      if (!parsed.success) {
        throw new Error('The booking was created but the response was not understood.');
      }
      return parsed.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bookingKeys.all });
    },
  });
}

/** A fresh idempotency key. Call once when a checkout attempt begins, never per retry. */
export function newIdempotencyKey(): string {
  return Crypto.randomUUID();
}

/**
 * Ask the API to start a payment. The response says where to send the user.
 *
 * The client deliberately has no provider knowledge. See schema.ts for why the URL
 * rather than a provider name is the contract.
 */
export function useStartPayment() {
  return useMutation<PaymentIntent, unknown, string>({
    mutationFn: (bookingId) => postParsed(`/bookings/${bookingId}/pay`, {}, paymentIntentSchema),
  });
}

export type PaymentOutcome =
  { kind: 'completed' } | { kind: 'dismissed' } | { kind: 'unsupported'; reason: string };

/**
 * Follow whatever `clientActionUrl` the backend returned.
 *
 * A relative path is an action on our own API and is POSTed with the user's credentials
 * attached — in QA that is the mock gateway, which settles the booking without money
 * moving. An absolute URL is a hosted provider page and opens in an in-app browser
 * (SFSafariViewController / Custom Tabs) rather than a WebView, because a payment page
 * must be able to show the user a real address bar and a real padlock, and because card
 * autofill and bank 3-D Secure apps only work in the system browser.
 */
export async function followPaymentAction(
  action: PaymentIntent,
  returnUrl: string,
): Promise<PaymentOutcome> {
  const url = action.clientActionUrl;
  if (!url) {
    return { kind: 'unsupported', reason: 'The payment provider did not return an action.' };
  }

  if (url.startsWith('/')) {
    // Strip the API's global prefix: the URL is absolute from the host root
    // ("/api/payments/..."), while apiClient's baseURL already ends in "/api".
    const path = url.replace(/^\/api/, '');
    // The `{}` is REQUIRED, not decoration. Without a second argument axios sends no
    // request body at all, Nest hands `@Body()` `undefined`, and a Zod object schema
    // rejects undefined even when every field in it has a default — so the mock
    // gateway's `{ outcome: enum.default('succeeded') }` schema 400s before any payment
    // logic runs. This broke the entire booking flow on Android: the user reached
    // "Continue to payment" and got "The request failed validation." with a real hold
    // already placed on their seats and no way forward. Caught on a physical Android
    // runtime; no test covered the request shape, only the branch that was taken.
    await apiClient.post(path, {});
    return { kind: 'completed' };
  }

  if (!url.startsWith('https://')) {
    // Refusing anything that is not https is a deliberate backstop: this URL comes from
    // the network, and following an arbitrary scheme would let a compromised response
    // launch an intent or a deep link of its choosing.
    return { kind: 'unsupported', reason: 'The payment link was not a secure web address.' };
  }

  const result = await WebBrowser.openAuthSessionAsync(url, returnUrl);
  // 'success' means the browser handed control back via returnUrl. It does NOT mean the
  // payment succeeded — only the API's booking status can say that, which is why the
  // checkout screen re-reads the booking rather than trusting this.
  return result.type === 'success' ? { kind: 'completed' } : { kind: 'dismissed' };
}

/**
 * Where a hosted payment page should send the user back to.
 *
 * Built with Linking.createURL rather than a hand-written "etickets://…" so it stays
 * correct in Expo Go and in dev builds, where the scheme is not the production one.
 */
export function paymentReturnUrl(bookingId: string): string {
  return Linking.createURL(`/booking/${bookingId}`);
}
