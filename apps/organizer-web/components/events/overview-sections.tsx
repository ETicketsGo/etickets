'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { api, ButtonLink, Card, Skeleton, money, type OrgEventDetail } from '@eticketsgo/web-kit';
import { isForbidden } from '@/lib/org-permissions';
import { EVENT_SECTIONS } from '@/lib/event-sections';
import { timeAtVenue } from './event-list-model';
import { sessionBreakdown, ticketTotals } from './event-overview-model';

/** A label over a figure, the unit every section below is built from. */
function Figure({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background-canvas p-3">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-title font-semibold tabular-nums text-text-primary">
        {value}
        {/* Inside the dd: a definition list's groups may hold only dt and dd. */}
        {hint ? (
          <span className="mt-0.5 block text-caption font-normal text-text-muted">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}

/** Sold, on hold and capacity across every session, from the ticket inventory. */
export function TicketsSection({ event }: { event: OrgEventDetail }) {
  const t = ticketTotals(event.sessions);
  const base = `/organizer/events/${event.id}`;
  const percent = t.capacity > 0 ? Math.min(100, Math.round((t.sold / t.capacity) * 100)) : null;
  return (
    <Card
      title="Tickets & capacity"
      action={
        <ButtonLink href={`${base}/tickets`} variant="ghost" size="sm">
          Manage tickets
        </ButtonLink>
      }
    >
      {t.types === 0 ? (
        <p className="text-[0.9375rem] text-text-muted">
          No ticket types yet. Add a session, then the tickets people can buy for it.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-3">
            <Figure label="Sold" value={t.sold} />
            <Figure label="On hold" value={t.held} hint="In a basket, not yet paid" />
            <Figure label="Capacity" value={t.capacity} />
          </dl>
          {percent !== null ? (
            <div className="mt-4">
              <div className="flex justify-between text-caption text-text-muted">
                <span>Sold of capacity</span>
                <span className="tabular-nums">{percent}%</span>
              </div>
              <div
                className="mt-1 h-2 w-full overflow-hidden rounded-full bg-background-subtle"
                role="img"
                aria-label={`${percent}% of capacity sold`}
              >
                <div
                  className="h-full rounded-full bg-action-primary"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          ) : null}
          <p className="mt-3 text-caption text-text-muted">
            Across {t.types} ticket type{t.types === 1 ? '' : 's'} in all sessions.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * The event's money, from its report - the same figures the Reports tab shows.
 *
 * Gross and net side by side and named as such: gross is what tickets sold for, net is gross
 * less the fees charged to the organizer and the refunds paid. Shown in the event's own
 * currency. A member who may not see money is told so instead of being shown an error.
 */
export function SalesSection({ event }: { event: OrgEventDetail }) {
  const base = `/organizer/events/${event.id}`;
  const report = useQuery({
    queryKey: ['event-report', event.id],
    queryFn: () => api.reports.event(event.id),
    enabled: !event.isFree,
    retry: false,
  });

  return (
    <Card
      title="Sales"
      action={
        <ButtonLink href={`${base}/reports`} variant="ghost" size="sm">
          Full report
        </ButtonLink>
      }
    >
      {event.isFree ? (
        <p className="text-[0.9375rem] text-text-muted">
          This is a free event. Nobody is charged, so there are no sales figures.
        </p>
      ) : report.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : report.isError ? (
        <p className="text-[0.9375rem] text-text-muted">
          {isForbidden(report.error)
            ? 'Sales figures are shown to owners and managers of this organization.'
            : 'We could not load the sales figures. Open the full report to try again.'}
        </p>
      ) : report.data ? (
        <>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Figure
              label="Gross ticket sales"
              value={money(report.data.grossTicketSalesMinor, report.data.currency)}
              hint="What confirmed tickets sold for"
            />
            <Figure
              label="Net to you"
              value={money(report.data.netOrganizerRevenueMinor, report.data.currency)}
              hint="Gross, less your fees and refunds"
            />
            <Figure label="Refunds" value={money(report.data.refundsMinor, report.data.currency)} />
            <Figure label="Tickets issued" value={report.data.ticketsSold} />
          </dl>
          <p className="mt-3 text-caption text-text-muted">
            In {report.data.currency}. Booking and payment fees paid by buyers are in the full
            report.
          </p>
        </>
      ) : null}
    </Card>
  );
}

const SHOWN_SESSIONS = 5;

/**
 * What is coming, soonest first, in the venue's own time - the first few only.
 *
 * Fifty sessions listed in full made the overview a schedule; the Sessions page is the
 * schedule. The counts say how many there are of each kind, so nothing is hidden by the cut.
 */
export function SessionsSection({ event }: { event: OrgEventDetail }) {
  const base = `/organizer/events/${event.id}`;
  const { upcoming, past, cancelled } = sessionBreakdown(event.sessions, Date.now());
  const shown = upcoming.slice(0, SHOWN_SESSIONS);
  const rest = upcoming.length - shown.length;
  return (
    <Card
      title="Sessions"
      action={
        <ButtonLink href={`${base}/sessions`} variant="ghost" size="sm">
          All sessions
        </ButtonLink>
      }
    >
      <p className="text-[0.875rem] text-text-muted">
        {upcoming.length} to come, {past} past
        {cancelled ? `, ${cancelled} cancelled` : ''}.
      </p>
      {shown.length > 0 ? (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {shown.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2.5 text-[0.9375rem]"
            >
              <span className="min-w-0 break-words text-text-primary">
                {timeAtVenue(s.startsAt, event.venue)}
              </span>
              <span className="min-w-0 break-words text-caption text-text-muted">
                {s.screen
                  ? `${s.screen.venue?.name ?? s.screen.cinema?.name ?? ''} ${s.screen.name}`.trim()
                  : 'General admission'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[0.9375rem] text-text-muted">
          {event.sessions.length === 0
            ? 'No sessions yet. Add one so people have a date to buy for.'
            : 'Nothing still to come.'}
        </p>
      )}
      {rest > 0 ? (
        <Link
          href={`${base}/sessions`}
          className="mt-3 inline-flex items-center gap-1 rounded text-[0.875rem] font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          +{rest} more session{rest === 1 ? '' : 's'} to come
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      ) : null}
    </Card>
  );
}

/** What each section is for, in the words an organizer arrives with. */
const SECTION_PURPOSE: Record<string, string> = {
  tickets: 'Dates, seat layouts, ticket types and extras',
  bookings: 'Who has booked, and their tickets',
  promotion: 'Share links and a QR code',
  checkin: 'Scan tickets at the door',
  reports: 'Sales and attendance in detail',
  settings: 'Title, description, pictures and terms',
};

/** The other sections, as a way in from the overview. Their own navigation is above. */
export function QuickLinks({ eventId }: { eventId: string }) {
  const base = `/organizer/events/${eventId}`;
  const sections = EVENT_SECTIONS.filter((s) => s.key !== 'overview');
  return (
    <Card title="Go to">
      <ul className="grid gap-2">
        {sections.map((s) => (
          <li key={s.key}>
            <Link
              href={`${base}${s.pages[0].seg}`}
              className="flex min-h-[2.75rem] items-center justify-between gap-3 rounded-md border border-border px-3 py-2 transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span className="min-w-0">
                <span className="block text-[0.9375rem] font-medium text-text-primary">
                  {s.label}
                </span>
                {SECTION_PURPOSE[s.key] ? (
                  <span className="block text-caption text-text-muted">
                    {SECTION_PURPOSE[s.key]}
                  </span>
                ) : null}
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
