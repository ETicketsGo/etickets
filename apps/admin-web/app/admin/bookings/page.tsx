'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import {
  api,
  Badge,
  Button,
  ButtonLink,
  Card,
  DataTable,
  Drawer,
  SearchInput,
  Pagination,
  PageHeader,
  GroupedSummary,
  type GroupSelection,
  EmptyState,
  money,
  dateTime,
  type Column,
  type AdminBookingRow,
} from '@eticketsgo/web-kit';
import { AccountContact } from '../../../components/account-contact';
import { CountryLabel } from '../../../components/country-filter';
import { MoneyStatusPill } from '../../../components/money-status';
import { moneyStatusLabel } from '../../../lib/money-status';
import {
  FilterBar,
  apiFilters,
  useFilterDescription,
  useUrlFilters,
} from '../../../components/list-filters';

const STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
  'DISPUTED',
];

/*
  Every filter lives in the URL, like the payment and refund queues beside this one: "bookings for
  this event in India last week" is a view somebody sends to a colleague. The keys are the same
  ones those queues use, so `?country=IN` links made before still land on the same list.
*/
const FILTER_KEYS = ['country', 'organizationId', 'eventId', 'status', 'from', 'to', 'q'] as const;

export default function AdminBookings() {
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState<GroupSelection>({});
  const filters = useUrlFilters(FILTER_KEYS);
  const { status, q: applied } = filters.values;
  const [q, setQ] = useState(applied);
  const scope = apiFilters(filters.values);
  const described = useFilterDescription(filters.values, undefined, applied);
  const [open, setOpen] = useState<AdminBookingRow | null>(null);
  const clearAll = () => {
    setQ('');
    filters.clear();
  };

  // Page 1 whenever a filter changes: page 4 of a narrower list is an empty table that looks
  // like "no results".
  useEffect(() => setPage(1), [filters.signature]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'bookings', page, filters.signature, group.groupBy, group.groupKey],
    enabled: !filters.invalidWindow,
    queryFn: () =>
      api.admin.bookings({
        page,
        pageSize: 15,
        ...group,
        ...scope,
        status: status || undefined,
        q: applied || undefined,
      }),
  });

  /*
    ── WHO BOUGHT WHAT, THEN WHAT IT COST, THEN WHERE IT GOT TO ─────────────────────
    A booking reads as the sale, the buyer, the money and how far it got. The country sits with
    the buyer rather than in its own column, because a sixth column is what pushed this table past
    its box on a laptop. On a phone each row is a card.
  */
  const columns: Column<AdminBookingRow>[] = [
    {
      key: 'sale',
      header: 'Booking',
      render: (b) => (
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-text-primary">{b.event.title}</p>
          <p className="font-mono text-caption text-text-muted">{b.reference ?? 'No reference'}</p>
        </div>
      ),
    },
    {
      key: 'buyer',
      header: 'Buyer',
      render: (b) => (
        <div className="min-w-0 space-y-1">
          <AccountContact email={b.buyerEmail} />
          <div>
            <CountryLabel stored={b.country} />
          </div>
        </div>
      ),
    },
    {
      key: 'total',
      header: 'Total',
      className: 'whitespace-nowrap tabular-nums',
      render: (b) => <span className="font-semibold">{money(b.totalMinor, b.currency)}</span>,
      sortable: true,
      sortValue: (b) => b.totalMinor,
    },
    {
      key: 'status',
      header: 'Status',
      render: (b) => (
        <div className="space-y-1">
          <MoneyStatusPill entity="booking" status={b.status} />
          {/* The payment is the booking's other half, and it can disagree with it. */}
          <p className="text-caption text-text-muted">
            {b.paymentStatus
              ? `Payment: ${moneyStatusLabel('payment', b.paymentStatus).toLowerCase()}`
              : 'No payment'}
          </p>
        </div>
      ),
    },
    {
      key: 'made',
      header: 'Made',
      className: 'whitespace-nowrap tabular-nums',
      render: (b) => (
        <span className="text-caption text-text-secondary">{dateTime(b.createdAt)}</span>
      ),
      sortable: true,
      sortValue: (b) => b.createdAt,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bookings"
        description="Every sale on the platform. Filter by market, organizer, event, status or date, and open one for a quick look."
      />

      <Card>
        <div className="space-y-4">
          <SearchInput
            value={q}
            onChange={setQ}
            onSubmit={() => filters.set({ q: q.trim() })}
            placeholder="Search booking reference or buyer email"
          />
          <FilterBar
            filters={{ ...filters, clear: clearAll }}
            statuses={STATUSES}
            statusName={(s) => moneyStatusLabel('booking', s)}
            countryHint="Where the event takes place. Dates are when the booking was made."
          />
        </div>
      </Card>

      <Card
        title="All bookings"
        action={
          data ? <Badge tone="neutral">{data.meta.total.toLocaleString()} matching</Badge> : null
        }
      >
        <GroupedSummary
          resource="bookings"
          options={['country', 'organizer', 'event']}
          value={group}
          status={status || undefined}
          q={applied || undefined}
          filters={scope}
          onChange={(next) => {
            // Page 1: the page number belonged to the previous scope, and page 4 of a group with
            // two rows is an empty table that looks like "no results".
            setGroup(next);
            setPage(1);
          }}
        />
        <DataTable
          caption="Bookings"
          columns={columns}
          rows={data?.data}
          loading={isLoading}
          density="compact"
          mobile="cards"
          error={isError ? "We couldn't load this. Please try again." : undefined}
          onRetry={() => refetch()}
          empty={
            <EmptyState
              title="No booking matches"
              hint={
                described
                  ? `Nothing matches ${described}.`
                  : 'A booking reference or a buyer email works in the search.'
              }
              action={
                filters.active ? (
                  <Button variant="outline" onClick={clearAll}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          }
          rowKey={(b) => b.id}
          onRowClick={(b) => setOpen(b)}
        />
        {data && data.meta.totalPages > 1 && (
          <div className="mt-4">
            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              onChange={setPage}
            />
          </div>
        )}
      </Card>

      <BookingQuickLook booking={open} onClose={() => setOpen(null)} />
    </div>
  );
}

/**
 * The booking as the list row knows it, without leaving the queue.
 *
 * Only the row's own fields: the full page has tickets, the payment and the refund actions, and
 * it is one click away. A quick look that fetched and acted would be a second detail page.
 */
function BookingQuickLook({
  booking,
  onClose,
}: {
  booking: AdminBookingRow | null;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={Boolean(booking)}
      onClose={onClose}
      title={booking?.reference ?? 'Booking'}
      description={booking?.event.title}
      footer={
        booking ? (
          <ButtonLink href={`/admin/bookings/${booking.id}`} icon={ArrowUpRight}>
            Open full booking
          </ButtonLink>
        ) : null
      }
    >
      {booking && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <MoneyStatusPill entity="booking" status={booking.status} />
            {booking.paymentStatus && (
              <MoneyStatusPill entity="payment" status={booking.paymentStatus} />
            )}
          </div>
          <p className="font-display text-headline font-bold tabular-nums text-text-primary">
            {money(booking.totalMinor, booking.currency)}
          </p>
          <dl className="divide-y divide-border rounded-lg border border-border text-ui">
            <QuickFact label="Event">{booking.event.title}</QuickFact>
            <QuickFact label="Reference">
              <span className="font-mono">{booking.reference ?? 'No reference'}</span>
            </QuickFact>
            <QuickFact label="Buyer">
              <AccountContact email={booking.buyerEmail} className="text-ui text-text-primary" />
            </QuickFact>
            <QuickFact label="Country">
              <CountryLabel stored={booking.country} />
            </QuickFact>
            <QuickFact label="Payment">
              {booking.paymentStatus
                ? moneyStatusLabel('payment', booking.paymentStatus)
                : 'No payment'}
            </QuickFact>
            <QuickFact label="Made">{dateTime(booking.createdAt)}</QuickFact>
          </dl>
        </div>
      )}
    </Drawer>
  );
}

function QuickFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2.5">
      <dt className="shrink-0 text-text-secondary">{label}</dt>
      <dd className="min-w-0 text-right text-text-primary">{children}</dd>
    </div>
  );
}
