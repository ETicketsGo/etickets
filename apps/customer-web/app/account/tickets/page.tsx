'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CalendarDays, ChevronRight, Ticket } from 'lucide-react';
import { api, tokenStore } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { EmptyState, ErrorState, StatusBadge, ButtonLink } from '@/components/ui';

const QR_FALLBACK =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112"><rect width="112" height="112" fill="#f1f5f9"/><text x="56" y="60" font-family="sans-serif" font-size="10" fill="#94a3b8" text-anchor="middle">QR unavailable</text></svg>',
  );

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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">My tickets</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Show the QR code at the gate to check in.
        </p>
      </div>

      {isError ? (
        <ErrorState
          message="We couldn't load your tickets. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <div className="grid gap-6 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-lg bg-background-subtle" />
          ))}
        </div>
      ) : data && data.length > 0 ? (
        <div className="grid gap-6 sm:grid-cols-2">
          {data.map((t) => (
            <Link
              key={t.id}
              href={`/account/tickets/${t.id}`}
              className="group flex overflow-hidden rounded-lg border border-border bg-background-surface shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {/* QR stub */}
              <div className="relative flex items-center justify-center border-r border-dashed border-border bg-background-subtle/50 p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={t.qrDataUrl}
                  alt={`QR code for ticket ${t.serial}`}
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (img.src !== QR_FALLBACK) img.src = QR_FALLBACK;
                  }}
                  className="h-28 w-28 rounded-md bg-white p-1"
                />
                <span className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-background-canvas" />
                <span className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-background-canvas" />
              </div>
              {/* Details */}
              <div className="flex min-w-0 flex-1 flex-col justify-between p-5">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge status={t.status} />
                    <ChevronRight className="h-4 w-4 text-text-muted transition-transform group-hover:translate-x-0.5" />
                  </div>
                  <p className="line-clamp-1 font-semibold text-text-primary">{t.event.title}</p>
                  <p className="text-[0.9375rem] text-text-secondary">{t.ticketType}</p>
                  <p className="flex items-center gap-1.5 text-caption text-text-muted">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {dateTime(t.startsAt)}
                  </p>
                </div>
                <p className="mt-3 font-mono text-caption text-text-muted">{t.serial}</p>
              </div>
            </Link>
          ))}
        </div>
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
