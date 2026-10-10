'use client';

import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Printer, Search, SearchX } from 'lucide-react';
import {
  api,
  Button,
  Card,
  DataTable,
  Drawer,
  EmptyState,
  Input,
  PageHeader,
  SectionCard,
  Select,
  StatusPill,
  dateTime,
  errorMessage,
  money,
  zoneAbbrev,
  type Column,
  type CounterBookingRow,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { bookingStatusLabel, bookingStatusTone, narrowingOptions } from '@/lib/booking-status';

/**
 * The box office counter's way in.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE DOOR ROSTER ────────────────────────────────
 * The door roster is per-session: it answers "who is coming to THIS screening", which is the
 * right question at a door and the wrong one at a counter. Somebody at a box office is holding
 * a phone call about "a booking under Srinivas, sometime tomorrow" - they do not know which
 * show, and making them pick one first is asking them to answer the question they rang up
 * to ask.
 *
 * ── WHY IT SHOWS NO CONTACT DETAILS ────────────────────────────────────────────────
 * The counter needs to FIND a booking, not read the customer's email and phone off a screen
 * that faces a queue. The customer is already in front of them or on the line. The API does
 * not send those fields, so this cannot show them by accident.
 *
 * ── WHY THE FILTERS NARROW THE RESULTS RATHER THAN THE SEARCH ──────────────────────
 * The endpoint answers one question - a name or a reference, three letters or more - and
 * refuses a search with nothing to search for, because that would be an export of every buyer.
 * So status and show are offered over the results already found ("the confirmed one, for
 * tomorrow's show"), never as a way to list bookings without a search.
 */

function when(b: CounterBookingRow): string {
  const zone = b.timezone ? zoneAbbrev(b.startsAt, b.timezone) : null;
  // The venue's time, so the counter reads it the way the ticket prints it.
  return `${dateTime(b.startsAt, undefined, b.timezone ?? undefined)}${zone ? ` (${zone})` : ''}`;
}

function BookingStatus({ status }: { status: string }) {
  return <StatusPill tone={bookingStatusTone(status)}>{bookingStatusLabel(status)}</StatusPill>;
}

/*
  Only a booking with tickets has anything to print. Offering the button on a pending one
  produces an empty sheet and a confused customer.
*/
function PrintLink({ booking, label }: { booking: CounterBookingRow; label: string }) {
  if (booking.ticketCount === 0) {
    return <span className="text-caption text-text-muted">Nothing to print</span>;
  }
  return (
    <a
      href={`/organizer/bookings/${booking.id}/print`}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      className="inline-flex items-center gap-1.5 rounded-md border border-border-input bg-background-surface px-3 py-1.5 text-ui font-medium text-text-primary transition-colors hover:bg-background-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Printer className="h-4 w-4" aria-hidden /> Print
    </a>
  );
}

export default function CounterBookingsPage() {
  const { activeOrg } = useOrg();
  const organizationId = activeOrg?.id;
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [status, setStatus] = useState('');
  const [event, setEvent] = useState('');
  const [open, setOpen] = useState<CounterBookingRow | null>(null);

  const results = useQuery({
    queryKey: ['counter-bookings', organizationId, applied],
    queryFn: () => api.checkins.findBookings(organizationId!, applied),
    // A search with nothing to search for is an export. See the service for why it refuses.
    enabled: Boolean(organizationId) && applied.length >= 3,
  });

  const rows = results.data ?? [];
  const statuses = narrowingOptions(rows, (b) => b.status, bookingStatusLabel);
  const events = narrowingOptions(
    rows,
    (b) => b.eventTitle,
    (v) => v,
  );
  const shown = rows.filter(
    (b) => (!status || b.status === status) && (!event || b.eventTitle === event),
  );

  const columns: Column<CounterBookingRow>[] = [
    {
      key: 'buyer',
      header: 'Booking',
      render: (b) => (
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-text-primary">{b.buyerName ?? 'No name given'}</p>
          <p className="whitespace-nowrap font-mono text-caption text-text-muted">
            {b.reference ?? 'No reference'}
          </p>
        </div>
      ),
    },
    {
      key: 'show',
      header: 'Show',
      render: (b) => (
        <div className="min-w-0 space-y-1">
          <p className="text-text-primary">{b.eventTitle}</p>
          <p className="text-caption text-text-muted">
            {b.screenName ? `${b.screenName} - ` : ''}
            {when(b)}
          </p>
        </div>
      ),
      sortable: true,
      sortValue: (b) => b.startsAt,
    },
    {
      key: 'total',
      header: 'Total',
      className: 'whitespace-nowrap tabular-nums',
      render: (b) => (
        <div className="space-y-1">
          <p className="font-semibold">{money(b.totalMinor, b.currency)}</p>
          <p className="text-caption text-text-muted">
            {b.ticketCount} ticket{b.ticketCount === 1 ? '' : 's'}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (b) => <BookingStatus status={b.status} />,
    },
    {
      key: 'print',
      header: <span className="sr-only">Print</span>,
      mobileLabel: 'Tickets',
      className: 'text-right',
      render: (b) => (
        <PrintLink
          booking={b}
          label={`Print tickets for ${b.buyerName ?? b.reference ?? 'this booking'}`}
        />
      ),
    },
  ];

  const narrowed = Boolean(status || event);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Find a booking"
        description="For the counter: look up a booking by name or reference, then print it."
      />

      <Card>
        <form
          role="search"
          className="flex flex-col gap-3 sm:flex-row sm:items-start"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(q.trim());
            // A new search is a new question: narrowing chosen for the last one would hide rows.
            setStatus('');
            setEvent('');
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              icon={Search}
              aria-label="Search by name or booking reference"
              placeholder="Name or booking reference"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Button type="submit" loading={results.isFetching} disabled={q.trim().length < 3}>
            Search
          </Button>
        </form>
        <p className="mt-2 text-caption text-text-muted">
          At least three characters. Bookings from every show in this organization.
        </p>
      </Card>

      {results.isError && (
        <Card>
          <p role="alert" className="text-ui text-status-error">
            {errorMessage(results.error)}
          </p>
        </Card>
      )}

      {applied.length < 3 && (
        <EmptyState
          icon={Search}
          title="Search to see bookings"
          hint="Type a buyer's name or a booking reference above. Results show the show, the total and whether the tickets can be printed."
          compact
        />
      )}

      {applied.length >= 3 && results.data && (
        <SectionCard
          title={`${rows.length} result${rows.length === 1 ? '' : 's'} for "${applied}"`}
          description={
            narrowed ? `Showing ${shown.length} of ${rows.length} after narrowing.` : undefined
          }
        >
          {rows.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title={`Nothing matches "${applied}"`}
              hint="Check the spelling, or try the booking reference from the customer's email."
              compact
            />
          ) : (
            <div className="space-y-4">
              {/* Only worth offering when it can narrow something. */}
              {(statuses.length > 1 || events.length > 1) && (
                <div
                  role="group"
                  aria-label="Narrow these results"
                  className="flex flex-col gap-3 sm:flex-row sm:items-end sm:[&>*]:min-w-0 sm:[&>*]:flex-1 sm:[&>button]:flex-none"
                >
                  {statuses.length > 1 && (
                    <Select
                      label="Status"
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="">Every status ({rows.length})</option>
                      {statuses.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label} ({s.count})
                        </option>
                      ))}
                    </Select>
                  )}
                  {events.length > 1 && (
                    <Select label="Show" value={event} onChange={(e) => setEvent(e.target.value)}>
                      <option value="">Every show ({rows.length})</option>
                      {events.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label} ({s.count})
                        </option>
                      ))}
                    </Select>
                  )}
                  {narrowed && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setStatus('');
                        setEvent('');
                      }}
                    >
                      Show all
                    </Button>
                  )}
                </div>
              )}
              <DataTable
                caption={`Bookings matching ${applied}`}
                columns={columns}
                rows={shown}
                rowKey={(b) => b.id}
                density="compact"
                mobile="cards"
                onRowClick={(b) => setOpen(b)}
                empty={
                  <EmptyState title="None of these results match" hint="Choose Show all." compact />
                }
              />
            </div>
          )}
        </SectionCard>
      )}

      <Drawer
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        title={open?.buyerName ?? 'Booking'}
        description={open?.reference ?? undefined}
        footer={
          open ? (
            <PrintLink
              booking={open}
              label={`Print tickets for ${open.buyerName ?? 'this booking'}`}
            />
          ) : null
        }
      >
        {open && (
          <div className="space-y-5">
            <BookingStatus status={open.status} />
            <p className="font-display text-headline font-bold tabular-nums text-text-primary">
              {money(open.totalMinor, open.currency)}
            </p>
            <dl className="divide-y divide-border rounded-lg border border-border text-ui">
              <Fact label="Show">{open.eventTitle}</Fact>
              {open.cinemaName && <Fact label="Venue">{open.cinemaName}</Fact>}
              {open.screenName && <Fact label="Screen">{open.screenName}</Fact>}
              <Fact label="When">{when(open)}</Fact>
              <Fact label="Tickets">{open.ticketCount}</Fact>
              <Fact label="Reference">
                <span className="font-mono">{open.reference ?? 'No reference'}</span>
              </Fact>
            </dl>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2.5">
      <dt className="shrink-0 text-text-secondary">{label}</dt>
      <dd className="min-w-0 text-right text-text-primary">{children}</dd>
    </div>
  );
}
