'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { api, StatusBadge, Skeleton, ErrorState } from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

/**
 * An event's sections, in groups.
 *
 * ── WHY THEY ARE GROUPED ───────────────────────────────────────────────────────────
 * There were eleven, and fifteen once offline check-in is on, all rendered as equally weighted
 * siblings in one scrolling row. Eleven equal choices is not a navigation, it is a filing
 * cabinet: "Promote" sat beside "Edit" with nothing to say that one is something you do once
 * before selling and the other is something you do on the day.
 *
 * Grouping is presentational only. Every section keeps its own route, every deep link still
 * resolves, and nothing is one click further away than it was - the labels sit between clusters
 * rather than becoming a layer you have to open.
 */
interface EventTab {
  label: string;
  seg: string;
}
interface EventTabGroup {
  /** Null for the lead section, which answers "what is happening with this event". */
  label: string | null;
  tabs: EventTab[];
}

const TAB_GROUPS: EventTabGroup[] = [
  { label: null, tabs: [{ label: 'Overview', seg: '' }] },
  {
    // Everything decided once, before anybody can buy.
    label: 'Setup',
    tabs: [
      { label: 'Edit', seg: '/edit' },
      { label: 'Sessions', seg: '/sessions' },
      { label: 'Tickets', seg: '/tickets' },
      { label: 'Commerce', seg: '/commerce' },
    ],
  },
  {
    label: 'Selling',
    tabs: [
      { label: 'Orders', seg: '/orders' },
      { label: 'Promote', seg: '/promote' },
    ],
  },
  {
    // What a box office opens on the day of the show.
    label: 'On the day',
    tabs: [
      { label: 'Check-in', seg: '/checkin' },
      { label: 'Attendees', seg: '/attendees' },
    ],
  },
  {
    label: 'After',
    tabs: [
      { label: 'Reports', seg: '/reports' },
      { label: 'Assistant', seg: '/assistant' },
    ],
  },
];

/** The offline check-in consoles, which belong with the rest of the day's work. */
const OFFLINE_TABS: EventTab[] = [
  { label: 'Command center', seg: '/command-center' },
  { label: 'Devices', seg: '/devices' },
  { label: 'Preflight', seg: '/preflight' },
  { label: 'Reconciliation', seg: '/reconciliation' },
];

export default function EventLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const { activeOrg, orgSentenceName } = useOrg();
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
  /*
    The offline consoles join "On the day" rather than trailing the row as four more siblings -
    they are the same job, done when the network is not there.
  */
  const groups: EventTabGroup[] = TAB_GROUPS.map((g) =>
    g.label === 'On the day' && offlineEnabled ? { ...g, tabs: [...g.tabs, ...OFFLINE_TABS] } : g,
  );

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
          {/*
            Whose event this is, when it is not the organization the switcher is on.

            An event is reachable by link as well as by browsing, so somebody can be looking at
            one organization's event while the console is set to another - and every action on
            this page would then read as belonging to the wrong one. Named only when they differ,
            using the one identity implementation, so the ordinary case stays quiet.
          */}
          {event &&
          event.organizationId !== activeOrg.id &&
          orgSentenceName(event.organizationId) ? (
            <span className="rounded-full bg-tint-warning px-3 py-1 text-caption font-medium text-status-warning">
              In {orgSentenceName(event.organizationId)}
            </span>
          ) : null}
        </div>
      )}

      <div className="overflow-x-auto border-b border-border">
        <nav className="flex min-w-max items-end gap-1" aria-label="Event sections">
          {groups.map((group) => (
            <div key={group.label ?? 'overview'} className="flex items-end">
              {group.label ? (
                <span
                  // Presentational: the grouping is a reading aid, and a screen reader gets the
                  // same structure from the link order without an invented landmark.
                  aria-hidden
                  className="mb-2 ml-3 mr-1 border-l border-border pl-3 text-caption uppercase tracking-wide text-text-muted"
                >
                  {group.label}
                </span>
              ) : null}
              {group.tabs.map((t) => {
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
            </div>
          ))}
        </nav>
      </div>

      <div>{children}</div>
    </div>
  );
}
