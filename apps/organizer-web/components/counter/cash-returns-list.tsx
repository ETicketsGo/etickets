'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  Button,
  DataTable,
  useToast,
  errorMessage,
  money,
  dateTime,
  type CashReturnRow,
  type Column,
} from '@eticketsgo/web-kit';
import { totalsText } from '@/lib/cancel-impact';

/**
 * Cash to give back at the counter, for bookings whose show was cancelled.
 *
 * The cancellation voids these bookings (their tickets stop working) but cannot pay anybody:
 * the money is in the venue's till. This is the list of whom to pay and how much, and the
 * button a person presses once the money is in the buyer's hand. Pressing it records who
 * handed it back and when. Nothing is sent to any payment provider.
 *
 * Used on the Counter page (every event) and in the summary after cancelling one event.
 */
export function CashReturnsList({
  organizationId,
  eventId,
  showEvent = true,
  hideWhenEmpty = false,
}: {
  organizationId: string;
  /** Only this event's bookings. */
  eventId?: string;
  /** Show which event each booking was for. Off when the list is already about one event. */
  showEvent?: boolean;
  /** Render nothing at all while there is nothing to give back. */
  hideWhenEmpty?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['cash-returns', organizationId, eventId ?? 'all'];
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: key,
    queryFn: () =>
      api.organizations.cashReturns(organizationId, { eventId, includeReturned: true }),
  });

  const mark = useMutation({
    mutationFn: (bookingId: string) =>
      api.organizations.markCashReturned(organizationId, bookingId),
    onSuccess: (r) => {
      toast.push(
        r.status === 'already_returned'
          ? 'Already recorded as given back. Nothing changed.'
          : 'Recorded: the cash was given back.',
        'success',
      );
      qc.invalidateQueries({ queryKey: ['cash-returns', organizationId] });
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const rows = data ?? [];
  const owed = rows.filter((r) => !r.returnedAt);
  if (hideWhenEmpty && !isLoading && !isError && rows.length === 0) return null;

  const owedTotals = Object.values(
    owed.reduce<Record<string, { currency: string; amountMinor: number }>>((acc, r) => {
      const t = (acc[r.currency] ??= { currency: r.currency, amountMinor: 0 });
      t.amountMinor += r.amountMinor;
      return acc;
    }, {}),
  );

  const columns: Column<CashReturnRow>[] = [
    {
      key: 'buyer',
      header: 'Booking',
      render: (r) => (
        <div>
          <p className="font-medium text-text-primary">{r.buyerName}</p>
          <p className="font-mono text-caption text-text-muted">{r.reference ?? r.bookingId}</p>
        </div>
      ),
    },
    ...(showEvent
      ? [
          {
            key: 'event',
            header: 'Show',
            render: (r: CashReturnRow) => (
              <div>
                <p className="text-text-primary">{r.eventTitle}</p>
                <p className="text-caption text-text-muted">{dateTime(r.startsAt)}</p>
              </div>
            ),
          } satisfies Column<CashReturnRow>,
        ]
      : []),
    {
      key: 'amount',
      header: 'Cash to give back',
      // Tabular figures: the person at the counter is counting notes against this.
      render: (r) => (
        <span className="font-semibold tabular-nums text-text-primary">
          {money(r.amountMinor, r.currency)}
        </span>
      ),
    },
    {
      key: 'action',
      header: '',
      mobileLabel: 'Given back',
      render: (r) =>
        r.returnedAt ? (
          <p className="text-caption text-text-muted">
            Given back {dateTime(r.returnedAt)}
            {r.returnedBy ? ` by ${r.returnedBy}` : ''}
          </p>
        ) : (
          <Button
            size="sm"
            variant="outline"
            loading={mark.isPending && mark.variables === r.bookingId}
            onClick={() => mark.mutate(r.bookingId)}
          >
            Mark as given back
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-2">
      <p className="text-[0.9375rem] text-text-secondary" role="status">
        {owed.length === 0
          ? rows.length === 0
            ? 'No cash to give back.'
            : 'All cash has been given back.'
          : `${owed.length} ${owed.length === 1 ? 'booking' : 'bookings'} to pay back in cash: ${totalsText(owedTotals)}.`}
      </p>
      <DataTable
        columns={columns}
        rows={rows}
        loading={isLoading}
        rowKey={(r) => r.bookingId}
        mobile="cards"
        error={isError ? "We couldn't load this. Please try again." : undefined}
        onRetry={() => refetch()}
        empty={<div className="p-6 text-center text-text-muted">No cash to give back.</div>}
      />
    </div>
  );
}
