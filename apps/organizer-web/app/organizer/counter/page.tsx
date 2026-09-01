'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
  dateTime,
  type Column,
  type CashBooking,
} from '@eticketsgo/web-kit';
import { useOrg } from '@/components/org-context';

/**
 * The counter: cash reserved but not yet handed over.
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

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['cash-bookings', activeOrg.id, showCollected],
    queryFn: () => api.organizations.cashBookings(activeOrg.id, showCollected),
  });

  const collect = useMutation({
    mutationFn: (bookingId: string) => api.payments.collectCash(bookingId),
    onSuccess: (r) => {
      toast.push(
        r.status === 'already_collected'
          ? 'Already collected — nothing changed.'
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
          <p className="text-caption text-text-muted">{dateTime(b.startsAt)}</p>
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
        description="Cash reserved for shows, and not yet handed over."
        action={
          <Button variant="outline" size="sm" onClick={() => setShowCollected((v) => !v)}>
            {showCollected ? 'Hide collected' : 'Show collected'}
          </Button>
        }
      />

      {/*
        Said once, plainly. Cash never reaches ETicketsGo, so it is not in a payout and the
        organizer should not go looking for it there. Discovering that at settlement instead
        would be a much worse way to learn it.
      */}
      <Card>
        <p className="text-[0.9375rem] text-text-secondary">
          Money taken here stays with you — it never passes through ETicketsGo, so it is not part of
          a payout. Pressing <strong>Collect</strong> issues the ticket and records who took the
          money.
        </p>
      </Card>

      <DataTable
        columns={columns}
        rows={data}
        loading={isLoading}
        rowKey={(b) => b.id}
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={
          <div className="p-8 text-center text-text-muted">
            Nothing waiting. Cash reservations appear here as soon as somebody makes one.
          </div>
        }
      />
    </div>
  );
}
