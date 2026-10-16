'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import {
  api,
  Button,
  Card,
  DataTable,
  PageHeader,
  StatusBadge,
  useToast,
  errorMessage,
  money,
  type Column,
  type CashBooking,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';
import { CounterSaleForm } from '@/components/counter/counter-sale-form';
import { CashReturnsList } from '@/components/counter/cash-returns-list';
import { timeAtVenue } from '@/components/events/event-list-model';

/**
 * The counter: selling to the person in front of you, and cash reserved but not yet handed over.
 *
 * ── TWO JOBS, ONE PAGE ─────────────────────────────────────────────────────────────
 * Selling at the counter (the form at the top) needs nothing switched on: the organizer's own
 * staff take the money. The list below is the other job - buyers who reserved online and pay
 * on arrival - and that one exists only while "Cash at the venue" is on. The page used to be
 * only the list, so with the switch off it was a dead end with nothing to do.
 *
 * ── WHO THIS IS FOR ────────────────────────────────────────────────────────────────
 * A single-screen cinema that takes cash. Somebody reserves seats online or by phone and
 * pays when they arrive; this is the list the person on the door works through, and the
 * button they press when the money is in the tin.
 *
 * Ordered by when the show starts rather than when the booking was made, because that is
 * the order the audience arrives in — a log sorted by creation time is a log, not a
 * worklist.
 */
export default function CounterPage() {
  const { activeOrg } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [showCollected, setShowCollected] = useState(false);
  /*
    Nothing can arrive here while the organization does not take cash: buyers are never offered
    "pay at the venue". The page used to say "Cash reservations appear here as soon as somebody
    makes one" regardless - a promise that could not come true, and a dead end.
  */
  const cashOn = activeOrg.cashPaymentsEnabled ?? false;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['cash-bookings', activeOrg.id, showCollected],
    queryFn: () => api.organizations.cashBookings(activeOrg.id, showCollected),
  });

  const collect = useMutation({
    mutationFn: (bookingId: string) => api.payments.collectCash(bookingId),
    onSuccess: (r) => {
      toast.push(
        r.status === 'already_collected'
          ? 'Already collected. Nothing changed.'
          : 'Cash recorded. The ticket is issued.',
        'success',
      );
      qc.invalidateQueries({ queryKey: ['cash-bookings', activeOrg.id] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const columns: Column<CashBooking>[] = [
    {
      key: 'buyer',
      header: 'Who',
      render: (b) => (
        <div>
          <p className="font-medium text-text-primary">{b.buyerName}</p>
          <p className="text-caption text-text-muted">{b.reference ?? b.buyerEmail}</p>
        </div>
      ),
    },
    {
      key: 'show',
      header: 'Show',
      render: (b) => (
        <div>
          <p className="text-text-primary">{b.eventTitle}</p>
          {/* On the venue's clock, with its zone: the reader may be anywhere. */}
          <p className="text-caption text-text-muted">
            {timeAtVenue(b.startsAt, { timezone: b.timezone ?? null })}
          </p>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'To collect',
      // Tabular figures: the person at the counter is comparing this against notes in hand.
      render: (b) => (
        <span className="font-semibold tabular-nums text-text-primary">
          {money(b.totalMinor, b.currency)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (b) =>
        b.collectedAt ? (
          <div className="space-y-0.5">
            <StatusBadge status="CONFIRMED" />
            <p className="text-caption text-text-muted">
              {b.collectedBy ? `Taken by ${b.collectedBy}` : 'Collected'}
            </p>
          </div>
        ) : (
          <StatusBadge status="PENDING_PAYMENT" />
        ),
    },
    {
      key: 'action',
      header: '',
      render: (b) =>
        b.collectedAt ? null : (
          <Button
            size="sm"
            loading={collect.isPending && collect.variables === b.id}
            onClick={() => collect.mutate(b.id)}
          >
            Collect {money(b.totalMinor, b.currency)}
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Counter"
        description="Sell tickets to people at the counter, and take cash for tickets reserved online."
      />

      <CounterSaleForm organizationId={activeOrg.id} />

      {/*
        Said once, plainly. Cash never reaches ETicketsGo, so it is not in a payout and the
        organizer should not go looking for it there. Discovering that at settlement instead
        would be a much worse way to learn it.
      */}
      <Card>
        <p className="text-[0.9375rem] text-text-secondary">
          Money taken here stays with you. It never passes through ETicketsGo, so it is not part of
          a payout. Every sale and every collection records who took the money.
        </p>
      </Card>

      {/*
        Cash owed back because a show was cancelled. Only shown while there is (or was) some, so
        a counter that never had a cancellation sees the page exactly as before.
      */}
      <CashReturnsSection organizationId={activeOrg.id} />

      <div className="flex flex-wrap items-end justify-between gap-3 pt-2">
        <div>
          <h2 className="text-title font-semibold text-text-primary">
            Reserved online, paying here
          </h2>
          <p className="text-caption text-text-muted">
            Press <strong>Collect</strong> when the money is in your hand: the ticket is issued.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowCollected((v) => !v)}>
          {showCollected ? 'Hide collected' : 'Show collected'}
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={data}
        loading={isLoading}
        rowKey={(b) => b.id}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={
          <div className="p-8 text-center text-text-muted">
            {cashOn ? (
              'Nothing waiting. Cash reservations appear here as soon as somebody makes one.'
            ) : (
              <>
                <p>
                  Online buyers cannot reserve and pay here: Cash at the venue is off. You can still
                  sell at the counter above.
                </p>
                <p className="mt-2">
                  To let online buyers pay when they arrive,{' '}
                  <Link
                    href="/organizer/settings"
                    className="font-medium text-action-primary underline underline-offset-2"
                  >
                    turn it on in Settings
                  </Link>
                  . Online sales are not affected either way.
                </p>
              </>
            )}
          </div>
        }
      />
    </div>
  );
}

function CashReturnsSection({ organizationId }: { organizationId: string }) {
  const { data } = useQuery({
    queryKey: ['cash-returns', organizationId, 'all'],
    queryFn: () => api.organizations.cashReturns(organizationId, { includeReturned: true }),
  });
  if (!data || data.length === 0) return null;
  return (
    <section className="space-y-2 pt-2" aria-labelledby="cash-returns-heading">
      <div>
        <h2 id="cash-returns-heading" className="text-title font-semibold text-text-primary">
          Cash to give back
        </h2>
        <p className="text-caption text-text-muted">
          These shows were cancelled, so their tickets no longer work. Give the cash back, then
          press <strong>Mark as given back</strong>. No money moves online.
        </p>
      </div>
      <CashReturnsList organizationId={organizationId} />
    </section>
  );
}
