'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { api, StatusBadge, Skeleton, ErrorState } from '@eticketsgo/web-kit';

const TABS = [
  { label: 'Overview', seg: '' },
  { label: 'Edit', seg: '/edit' },
  { label: 'Sessions', seg: '/sessions' },
  { label: 'Tickets', seg: '/tickets' },
  { label: 'Orders', seg: '/orders' },
  { label: 'Attendees', seg: '/attendees' },
  { label: 'Check-in', seg: '/checkin' },
  { label: 'Reports', seg: '/reports' },
];

export default function EventLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const base = `/organizer/events/${id}`;
  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id),
  });

  // The Reconciliation console is an offline-gate feature — only surface its tab
  // when the org has offline check-in enabled (flag off → endpoints 404).
  const offlineReadiness = useQuery({
    queryKey: ['offline-readiness', event?.organizationId],
    queryFn: () => api.offlineCheckin.offlineReadiness(event!.organizationId),
    enabled: !!event?.organizationId,
    retry: false,
  });
  const offlineEnabled =
    offlineReadiness.data?.checks.find((c) => c.key === 'flag')?.passed ?? false;
  const tabs = offlineEnabled
    ? [
        ...TABS,
        { label: 'Command center', seg: '/command-center' },
        { label: 'Reconciliation', seg: '/reconciliation' },
      ]
    : TABS;

  if (isError)
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-text-muted">
        <Link href="/organizer/events" className="hover:text-text-primary">
          Events
        </Link>{' '}
        / <span className="text-text-secondary">{event?.title ?? '…'}</span>
      </nav>

      {isLoading ? (
        <Skeleton className="h-8 w-64" />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-text-primary">{event?.title}</h1>
          {event && <StatusBadge status={event.status} />}
        </div>
      )}

      <div className="overflow-x-auto border-b border-border">
        <nav className="flex min-w-max gap-1" aria-label="Event sections">
          {tabs.map((t) => {
            const href = `${base}${t.seg}`;
            const active = t.seg === '' ? pathname === base : pathname === href;
            return (
              <Link
                key={t.label}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
                  active
                    ? 'border-action-primary font-medium text-action-primary'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div>{children}</div>
    </div>
  );
}
