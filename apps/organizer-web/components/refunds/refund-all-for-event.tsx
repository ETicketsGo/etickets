'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Card,
  Dialog,
  errorMessage,
  money,
  useToast,
  type OrganizationRefundRow,
} from '@eticketsgo/web-kit';

/** Every refund request still waiting on one event, across pages. */
async function waitingFor(organizationId: string, eventId: string) {
  const rows: OrganizationRefundRow[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const r = await api.organizations.refunds(organizationId, {
      status: 'REQUESTED',
      eventId,
      page,
      pageSize: 100,
    });
    rows.push(...r.data);
    if (page >= r.meta.totalPages) break;
  }
  return rows;
}

/**
 * "Refund everybody" for an event the organizer cancelled.
 *
 * ── WHY IT IS THE SAME BUTTON, PRESSED FOR EACH ──────────────────────────────────────
 * Cancelling an event opens one refund request per paid booking, and each one used to need
 * its own Refund and confirm: forty buyers, eighty presses. This sends each request through the
 * same approval the row's Refund button uses (`POST /refunds/:id/process`), one at a time, so
 * every refund goes back by its own payment method, voids its own tickets and issues its own
 * credit note exactly as it always did. The server claims each request before it moves money,
 * so a second press, or another person approving the same row, cannot refund it twice.
 *
 * Owner only, as each approval is. Money leaving is confirmed with the count and the total.
 */
export function RefundAllForEvent({
  organizationId,
  eventId,
}: {
  organizationId: string;
  eventId: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  /* The requests as they were when the dialog opened: what the person confirmed is what runs. */
  const [batch, setBatch] = useState<OrganizationRefundRow[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; failed: string[] } | null>(null);
  const open = batch !== null;
  const running = progress !== null && progress.done < (batch?.length ?? 0);

  const waitingQ = useQuery({
    queryKey: ['refunds-waiting-for-event', organizationId, eventId],
    queryFn: () => waitingFor(organizationId, eventId),
  });
  const waiting = waitingQ.data ?? [];
  if (waiting.length < 2 && !batch) return null;
  const rows = batch ?? waiting;

  const currency = rows[0].booking?.currency ?? 'INR';
  const sameCurrency = rows.every((r) => (r.booking?.currency ?? 'INR') === currency);
  const total = rows.reduce((sum, r) => sum + r.amountMinor, 0);

  const runAll = async () => {
    setProgress({ done: 0, failed: [] });
    const failed: string[] = [];
    let done = 0;
    for (const row of rows) {
      try {
        await api.refunds.process(row.id, 'APPROVE');
      } catch (e) {
        failed.push(
          `${row.booking?.reference ?? row.booking?.buyerName ?? row.id}: ${errorMessage(e)}`,
        );
      }
      done += 1;
      setProgress({ done, failed: [...failed] });
    }
    qc.invalidateQueries({ queryKey: ['org-refunds', organizationId] });
    qc.invalidateQueries({ queryKey: ['refunds-waiting-for-event', organizationId, eventId] });
    qc.invalidateQueries({ queryKey: ['receipts', organizationId] });
    toast.push(
      failed.length === 0
        ? `${done} refunds approved. The money is on its way back.`
        : `${done - failed.length} of ${done} refunds approved. ${failed.length} did not go through; they are listed under Failed.`,
      failed.length === 0 ? 'success' : 'error',
    );
  };

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[0.9375rem] text-text-primary">
            <strong>{rows.length} refund requests</strong> are waiting on this event
            {sameCurrency ? `, ${money(total, currency)} in all` : ''}.
          </p>
          <Button onClick={() => setBatch(waiting)}>Refund all {rows.length}</Button>
        </div>
      </Card>
      <Dialog
        open={open}
        onClose={() => {
          if (running) return;
          setBatch(null);
          setProgress(null);
        }}
        title={`Refund all ${rows.length} bookings?`}
      >
        <div className="space-y-4">
          <p className="text-body text-text-secondary">
            {sameCurrency ? (
              <strong className="text-text-primary">{money(total, currency)}</strong>
            ) : (
              'The money'
            )}{' '}
            goes back to {rows.length} buyers, each through their original payment method. Their
            tickets are voided and a credit note is issued for each. This cannot be undone.
          </p>
          {progress ? (
            <div role="status" className="space-y-1 text-caption">
              <p className="text-text-primary">
                {progress.done < rows.length
                  ? `Refunding ${progress.done + 1} of ${rows.length}...`
                  : `Done: ${rows.length - progress.failed.length} refunded, ${progress.failed.length} failed.`}
              </p>
              {progress.failed.map((f) => (
                <p key={f} className="text-status-error">
                  {f}
                </p>
              ))}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            {progress && progress.done >= rows.length ? (
              <Button
                onClick={() => {
                  setBatch(null);
                  setProgress(null);
                }}
              >
                Close
              </Button>
            ) : (
              <>
                <Button variant="secondary" disabled={running} onClick={() => setBatch(null)}>
                  Cancel
                </Button>
                <Button loading={running} onClick={runAll}>
                  Refund all now
                </Button>
              </>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
