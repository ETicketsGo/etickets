import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiClient } from '@/services/api-client';
import { getParsed } from '@/services/http';
import { bookingKeys } from './api';

/**
 * Cancelling and refunds, as the customer sees them.
 *
 * The SERVER decides every case: whether a booking may be cancelled or refunded, how much,
 * and when. The app shows the window the event declares (refundsEnabled and the cutoff
 * before the start), sends the request, and shows what the server answered. It never
 * computes an amount and never marks anything refunded itself.
 */

export const refundSchema = z.object({
  id: z.string(),
  status: z.string(),
  amountMinor: z.number().int().nullish(),
  currency: z.string().nullish(),
  reason: z.string().nullish(),
  createdAt: z.string(),
});
export type Refund = z.infer<typeof refundSchema>;

export const refundKeys = {
  forBooking: (bookingId: string) => ['refunds', 'booking', bookingId] as const,
};

export function useBookingRefunds(bookingId: string, enabled: boolean) {
  return useQuery({
    queryKey: refundKeys.forBooking(bookingId),
    queryFn: () => getParsed(`/refunds/booking/${bookingId}`, z.array(refundSchema)),
    enabled: enabled && bookingId.length > 0,
    staleTime: 15_000,
  });
}

export function useRequestRefund(bookingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      apiClient.post('/refunds', { bookingId, reason: reason.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: refundKeys.forBooking(bookingId) });
      void queryClient.invalidateQueries({ queryKey: bookingKeys.all });
    },
  });
}

/** Release an UNPAID hold. A paid booking is never cancelled this way: it is refunded. */
export function useCancelUnpaid(bookingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post(`/bookings/${bookingId}/cancel`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: bookingKeys.all }),
  });
}

export type RefundWindow =
  | { kind: 'open'; closesAt: Date }
  | { kind: 'closed'; closedAt: Date }
  | { kind: 'not-offered' }
  | { kind: 'not-applicable' };

/**
 * Whether the customer may ask for a refund now, from the event's own declaration: refunds
 * enabled, and more than `refundCutoffHours` before the start. Only a paid booking can be
 * refunded. The server checks again and may still say no (a transferred ticket, a refund
 * already in progress); this only decides what to offer.
 */
export function refundWindow(
  input: {
    status: string;
    startsAt: string;
    refundsEnabled?: boolean | null;
    refundCutoffHours?: number | null;
  },
  now: number,
): RefundWindow {
  const status = input.status.toUpperCase();
  if (status !== 'CONFIRMED' && status !== 'PARTIALLY_REFUNDED') return { kind: 'not-applicable' };
  if (!input.refundsEnabled) return { kind: 'not-offered' };
  const cutoffMs = Math.max(0, input.refundCutoffHours ?? 0) * 3_600_000;
  const closesAt = new Date(new Date(input.startsAt).getTime() - cutoffMs);
  return now < closesAt.getTime()
    ? { kind: 'open', closesAt }
    : { kind: 'closed', closedAt: closesAt };
}

/** Words for a refund's state, so the screen never shows a raw enum. */
export function refundStatusLabel(status: string): {
  label: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
} {
  switch (status.toUpperCase()) {
    case 'REQUESTED':
      return { label: 'Requested, waiting for the organizer', tone: 'warning' };
    case 'APPROVED':
      return { label: 'Approved, being sent back', tone: 'warning' };
    case 'PROCESSING':
      return { label: 'On its way to you', tone: 'warning' };
    case 'COMPLETED':
      return { label: 'Refunded', tone: 'success' };
    case 'REJECTED':
      return { label: 'Not approved', tone: 'error' };
    case 'FAILED':
      return { label: 'Could not be sent. We are looking into it', tone: 'error' };
    default:
      return { label: status, tone: 'neutral' };
  }
}
