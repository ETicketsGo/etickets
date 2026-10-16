'use client';

import Link from 'next/link';
import { Button, Dialog, type EventCancelResult } from '@eticketsgo/web-kit';
import { CashReturnsList } from '@/components/counter/cash-returns-list';
import { totalsText } from '@/lib/cancel-impact';

/**
 * What the cancellation did, and what is left for the organizer to do: approve the refunds,
 * and hand back the cash, booking by booking. A toast used to say this in one line that
 * vanished after a few seconds, with no list of whom to pay.
 */
export function CancelEventResultDialog({
  result,
  eventId,
  organizationId,
  onClose,
}: {
  result: EventCancelResult | null;
  eventId: string;
  organizationId: string;
  onClose: () => void;
}) {
  const refunds = result?.refundsAwaiting;
  const cashCount = result?.cashToReturn ?? 0;
  return (
    <Dialog
      open={result !== null}
      onClose={onClose}
      title="Event cancelled"
      // Wide enough for the cash list: name, amount and the button on one line.
      size="lg"
      footer={
        <>
          {refunds && refunds.count > 0 ? (
            <Link
              href={`/organizer/refunds?event=${eventId}`}
              className="inline-flex min-h-[2.5rem] items-center rounded-md px-3 text-sm font-medium text-action-primary underline underline-offset-2"
            >
              Review refunds
            </Link>
          ) : null}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      {result && (
        <div className="space-y-4 text-[0.9375rem] text-text-secondary">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Sales stopped. {result.datesCancelled}{' '}
              {result.datesCancelled === 1 ? 'date was' : 'dates were'} cancelled.
            </li>
            <li>
              {refunds && refunds.count > 0
                ? `${refunds.count} ${refunds.count === 1 ? 'refund is' : 'refunds are'} waiting for your approval: ${totalsText(refunds.totals)}. Approve ${refunds.count === 1 ? 'it' : 'them'} on Refunds.`
                : 'No online refunds are waiting for approval.'}
            </li>
            <li>
              {cashCount > 0
                ? `${cashCount} cash ${cashCount === 1 ? 'booking was' : 'bookings were'} cancelled and ${cashCount === 1 ? 'its tickets no longer work' : 'their tickets no longer work'}. Give back ${totalsText(result.cashTotals ?? [])} in cash at the counter.`
                : 'No cash to give back.'}
            </li>
          </ul>
          {cashCount > 0 ? (
            <div className="space-y-2">
              <h3 className="text-[0.9375rem] font-semibold text-text-primary">
                Cash to give back
              </h3>
              <CashReturnsList
                organizationId={organizationId}
                eventId={eventId}
                showEvent={false}
              />
              <p className="text-caption text-text-muted">
                This list stays on the{' '}
                <Link
                  href="/organizer/counter"
                  className="font-medium text-action-primary underline underline-offset-2"
                >
                  Counter
                </Link>{' '}
                page. Marking a booking as given back is a record for your team. No money moves
                online.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
