'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Ticket } from 'lucide-react';
import { groupWalletTickets } from '@eticketsgo/web-kit';
import { api, tokenStore } from '@/lib/api';
import { EmptyState, ErrorState, ButtonLink } from '@/components/ui';
import { BookingGroupCard } from '@/components/booking-group-card';

export default function TicketsPage() {
  const router = useRouter();
  useEffect(() => {
    if (!tokenStore.access) router.push('/login?next=/account/tickets');
  }, [router]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['wallet'],
    queryFn: () => api.wallet(),
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
  });

  // Group by booking on the client — the wallet response already carries bookingId
  // and seat/venue/screen context, so no extra requests are needed.
  const groups = useMemo(() => (data ? groupWalletTickets(data) : []), [data]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">My tickets</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Tickets are grouped by booking. Open a booking to show each QR code at the gate.
        </p>
      </div>

      {isError ? (
        <ErrorState
          message="We couldn't load your tickets. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <div className="grid gap-6 sm:grid-cols-2" aria-busy="true" aria-label="Loading tickets">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-64 animate-pulse rounded-lg bg-background-subtle" />
          ))}
        </div>
      ) : groups.length > 0 ? (
        <ul className="grid list-none gap-6 sm:grid-cols-2">
          {groups.map((group) => (
            <li key={group.bookingId}>
              <BookingGroupCard group={group} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No tickets yet"
          hint="Book an event to see your QR passes here."
          icon={Ticket}
          action={<ButtonLink href="/events">Browse events</ButtonLink>}
        />
      )}
    </div>
  );
}
