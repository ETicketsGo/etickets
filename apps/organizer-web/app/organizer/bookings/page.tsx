'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Printer, Search } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  Card,
  Input,
  PageHeader,
  dateTime,
  errorMessage,
  money,
  zoneAbbrev,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

/**
 * The box office counter's way in.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE DOOR ROSTER ────────────────────────────────
 * The door roster is per-session: it answers "who is coming to THIS screening", which is the
 * right question at a door and the wrong one at a counter. Somebody at a box office is holding
 * a phone call about "a booking under Srinivas, sometime tomorrow" — they do not know which
 * show, and making them pick one first is asking them to answer the question they rang up
 * to ask.
 *
 * ── WHY IT SHOWS NO CONTACT DETAILS ────────────────────────────────────────────────
 * The counter needs to FIND a booking, not read the customer's email and phone off a screen
 * that faces a queue. The customer is already in front of them or on the line. The API does
 * not send those fields, so this cannot show them by accident.
 */
export default function CounterBookingsPage() {
  const { activeOrg } = useOrg();
  const organizationId = activeOrg?.id;
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');

  const results = useQuery({
    queryKey: ['counter-bookings', organizationId, applied],
    queryFn: () => api.checkins.findBookings(organizationId!, applied),
    // A search with nothing to search for is an export. See the service for why it refuses.
    enabled: Boolean(organizationId) && applied.length >= 3,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Find a booking"
        description="For the counter: look up a booking by name or reference, then print it."
      />

      <Card>
        <form
          className="flex items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(q.trim());
          }}
        >
          <Input
            aria-label="Search by name or booking reference"
            placeholder="Name or booking reference"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" loading={results.isFetching} disabled={q.trim().length < 3}>
            <Search className="h-4 w-4" aria-hidden /> Search
          </Button>
        </form>
        <p className="mt-2 text-caption text-text-muted">
          At least three characters. Bookings from every show in this organization.
        </p>
      </Card>

      {results.isError && (
        <Card>
          <p role="alert" className="text-sm text-status-error">
            {errorMessage(results.error)}
          </p>
        </Card>
      )}

      {applied.length >= 3 && results.data && (
        <Card title={`${results.data.length} result${results.data.length === 1 ? '' : 's'}`}>
          {results.data.length === 0 ? (
            <p className="text-sm text-text-muted">Nothing matches “{applied}”.</p>
          ) : (
            <ul className="divide-y divide-border">
              {results.data.map((b) => {
                const zone = b.timezone ? zoneAbbrev(b.startsAt, b.timezone) : null;
                return (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-medium text-text-primary">
                        {b.buyerName ?? '—'}
                        {b.reference && (
                          <span className="ml-2 font-mono text-caption text-text-muted">
                            {b.reference}
                          </span>
                        )}
                      </p>
                      <p className="text-caption text-text-muted">
                        {b.eventTitle}
                        {b.screenName && ` · ${b.screenName}`}
                        {' · '}
                        {/* The venue's time, so the counter reads it the way the ticket prints it. */}
                        {dateTime(b.startsAt, undefined, b.timezone ?? undefined)}
                        {zone ? ` (${zone})` : ''}
                      </p>
                      <p className="text-caption text-text-muted">
                        {b.ticketCount} ticket{b.ticketCount === 1 ? '' : 's'} ·{' '}
                        {money(b.totalMinor, b.currency)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={b.status === 'CONFIRMED' ? 'success' : 'neutral'}>
                        {b.status.replaceAll('_', ' ').toLowerCase()}
                      </Badge>
                      {/*
                        Only a confirmed booking has tickets to print. Offering the button on a
                        pending one produces an empty sheet and a confused customer.
                      */}
                      {b.ticketCount > 0 && (
                        <a
                          href={`/organizer/bookings/${b.id}/print`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-background-subtle"
                        >
                          <Printer className="h-4 w-4" aria-hidden /> Print
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
