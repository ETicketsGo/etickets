import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { getParsed } from '@/services/http';
import { bookingDetailSchema, bookingPageSchema, ticketSchema } from './schema';

export const bookingKeys = {
  all: ['bookings'] as const,
  list: () => [...bookingKeys.all, 'list'] as const,
  detail: (id: string) => [...bookingKeys.all, 'detail', id] as const,
  tickets: () => ['tickets'] as const,
};

export function useBookings() {
  return useQuery({
    queryKey: bookingKeys.list(),
    queryFn: () => getParsed('/bookings', bookingPageSchema, { page: 1, pageSize: 50 }),
    // A booking that is mid-payment changes within seconds, so this stays short.
    staleTime: 10_000,
  });
}

/** How often a booking that is waiting for payment is re-read, and for how long. */
export const PAYMENT_POLL_INTERVAL_MS = 3_000;
export const PAYMENT_POLL_WINDOW_MS = 2 * 60_000;

/**
 * Whether a booking should be read again soon. Only an unpaid booking changes on its
 * own: the provider's signed webhook confirms it a few seconds after the buyer pays.
 * The app never decides a payment succeeded, so it waits for the server to say so, for
 * a bounded time, and then leaves a manual refresh.
 */
export function paymentPollInterval(
  status: string | undefined,
  firstSeenAt: number,
  now: number = Date.now(),
): number | false {
  if (status?.toUpperCase() !== 'PENDING_PAYMENT') return false;
  return now - firstSeenAt < PAYMENT_POLL_WINDOW_MS ? PAYMENT_POLL_INTERVAL_MS : false;
}

/** One booking, read from the server. Polls while payment is pending. */
export function useBooking(id: string) {
  // When this screen started watching. Fixed for the screen's life.
  const [firstSeenAt] = useState(() => Date.now());
  const query = useQuery({
    queryKey: bookingKeys.detail(id),
    queryFn: () => getParsed(`/bookings/${id}`, bookingDetailSchema),
    enabled: id.length > 0,
    staleTime: 0,
    refetchInterval: (q) => paymentPollInterval(q.state.data?.status, firstSeenAt),
  });
  const polling = paymentPollInterval(query.data?.status, firstSeenAt) !== false;
  return Object.assign(query, { polling });
}

/**
 * The user's tickets, including the server-rendered QR image.
 *
 * `gcTime` is a week rather than the default five minutes because this is the query
 * that has to survive being offline. Someone arriving at a venue with no signal needs
 * the ticket they loaded at home that morning, and a garbage-collected cache is an
 * empty screen at the door. The persister (see application/query-client.ts) writes it
 * to disk so it also survives the app being killed.
 */
export function useTickets() {
  return useQuery({
    queryKey: bookingKeys.tickets(),
    queryFn: () => getParsed('/tickets', z.array(ticketSchema)),
    staleTime: 60_000,
    gcTime: 7 * 24 * 60 * 60_000,
  });
}
