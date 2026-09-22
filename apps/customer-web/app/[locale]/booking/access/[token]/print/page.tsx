'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { GuestPrintSheet } from '@/components/guest-booking-view';

/**
 * A guest's tickets, full size and printable, from the emailed link.
 *
 * The token in the address is the whole credential here, exactly as on the page this is
 * reached from, so the same query key is used and the booking is not fetched twice.
 */
export default function GuestAccessPrintPage() {
  const { token } = useParams<{ token: string }>();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['guest-access', token],
    queryFn: () => api.guestBookingByAccessToken(token),
  });

  return (
    <GuestPrintSheet
      view={data}
      backHref={`/booking/access/${token}`}
      isLoading={isLoading}
      isError={isError}
    />
  );
}
