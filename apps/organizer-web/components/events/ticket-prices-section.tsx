'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { ButtonLink, Card, type OrgEventDetail } from '@eticketsgo/web-kit';
import { stockLine, ticketPriceList, type PriceRow } from '@/lib/ticket-prices';
import { timeAtVenue } from './event-list-model';

function PriceRows({ rows }: { rows: PriceRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-[0.9375rem] text-text-muted">No ticket types for this session yet.</p>
    );
  }
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {rows.map((r) => (
        <li key={r.id} className="px-3 py-2.5" data-testid="price-row">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="min-w-0 break-words font-medium text-text-primary [overflow-wrap:anywhere]">
              {r.name}
              {r.active ? null : (
                <span className="ml-2 rounded-full bg-background-subtle px-2 py-0.5 text-micro font-semibold text-text-muted">
                  Not on sale
                </span>
              )}
            </span>
            <span className="shrink-0 font-semibold tabular-nums text-text-primary">{r.price}</span>
          </div>
          <p className="mt-0.5 text-caption tabular-nums text-text-muted">{stockLine(r)}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * What each ticket costs, per session, with how many are sold and left. Read-only: prices are
 * changed on the Tickets page, which "Edit prices" opens.
 */
export function TicketPricesSection({ event }: { event: OrgEventDetail }) {
  const base = `/organizer/events/${event.id}`;
  const list = ticketPriceList(event.sessions, { eventIsFree: event.isFree, now: Date.now() });
  // One session needs no heading: the list is simply the event's tickets.
  const grouped = list.groups.length > 1 || list.hiddenSessions > 0;

  return (
    <Card
      title="Tickets and prices"
      action={
        <ButtonLink href={`${base}/tickets`} variant="ghost" size="sm">
          Edit prices
        </ButtonLink>
      }
    >
      <div data-testid="ticket-prices">
        {list.groups.length === 0 ? (
          <p className="text-[0.9375rem] text-text-muted">
            No sessions yet. Add a session, then the tickets people can buy for it.
          </p>
        ) : grouped ? (
          <div className="space-y-4">
            {list.groups.map((g) => (
              <div key={g.sessionId} className="min-w-0">
                <h3 className="mb-1.5 break-words text-sm font-semibold text-text-primary">
                  {timeAtVenue(g.startsAt, event.venue)}
                  {g.ended ? <span className="font-normal text-text-muted"> (ended)</span> : null}
                </h3>
                <PriceRows rows={g.rows} />
              </div>
            ))}
          </div>
        ) : (
          <PriceRows rows={list.groups[0].rows} />
        )}

        {list.hiddenSessions > 0 ? (
          <Link
            href={`${base}/tickets`}
            className="mt-3 inline-flex items-center gap-1 rounded text-[0.875rem] font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            +{list.hiddenSessions} more session{list.hiddenSessions === 1 ? '' : 's'} on the Tickets
            page
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : null}
        {list.cancelledSessions > 0 ? (
          <p className="mt-2 text-caption text-text-muted">
            {list.cancelledSessions} cancelled session{list.cancelledSessions === 1 ? '' : 's'} not
            shown.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
