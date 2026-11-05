import { apiClient } from '@/services/api-client';

/**
 * The booking's status as the server sees it right now, or null if it could not be read.
 *
 * Used after the buyer leaves a payment screen without the app being told the result.
 * Never throws: an unreadable status is treated as "still unpaid", which keeps the hold
 * and offers a retry rather than claiming anything.
 */
export async function readBookingStatus(bookingId: string): Promise<string | null> {
  try {
    const { data } = await apiClient.get(`/bookings/${bookingId}`);
    const status = (data as { status?: unknown } | null)?.status;
    return typeof status === 'string' ? status.toUpperCase() : null;
  } catch {
    return null;
  }
}
