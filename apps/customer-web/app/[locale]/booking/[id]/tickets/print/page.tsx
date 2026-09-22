'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { guestTokenFor } from '@/lib/guest-session';
import { GuestBookingNotHere, GuestPrintSheet } from '@/components/guest-booking-view';

/**
 * A guest's tickets, full size and printable, straight after paying.
 *
 * Proved by the anonymous session this browser holds for the booking - the same token that drew
 * the confirmation screen - so it works without an account and without the emailed link, which
 * is the point: the guest can keep their ticket before any email has arrived.
 */
export default function GuestTicketsPrintPage() {
  const { id } = useParams<{ id: string }>();
  // Read after mount: the session lives in this browser's storage, which the server cannot see.
  const [session, setSession] = useState<string | null | undefined>(undefined);
  useEffect(() => setSession(guestTokenFor(id)), [id]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['guest-booking', id, session],
    enabled: Boolean(session),
    queryFn: () => api.getGuestBooking(id, session as string),
  });

  if (session === null) return <GuestBookingNotHere />;
  return (
    <GuestPrintSheet
      view={data}
      backHref={`/booking/${id}/confirmation`}
      isLoading={session === undefined || isLoading}
      isError={isError}
    />
  );
}
