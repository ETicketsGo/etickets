import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { getParsed } from '@/services/http';
import { bookingPageSchema, ticketSchema } from './schema';

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
