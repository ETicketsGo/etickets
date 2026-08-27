'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  api,
  Button,
  Dialog,
  DateTimeField,
  Input,
  Skeleton,
  useToast,
  errorMessage,
  money,
  type ShowRow,
} from '@eticketsgo/web-kit';

/**
 * Everything you can change about a show that already exists.
 *
 * ── WHY THIS REPLACED "MOVE" ───────────────────────────────────────────────────────
 * Reported: "still I don't see edit option for current shows, I see only Move option."
 * That was accurate. `reschedule`, `pricing`, `pause`, `reopen` and `cancel` all existed in
 * the API; the console called exactly one of them. An operator who had typed the wrong price
 * — or needed to stop selling a show for an hour — had no way to say so, and the only tool
 * on the row was one that changed the time, which was not what they wanted.
 *
 * ── WHY FOUR BUTTONS AND NOT ONE "SAVE" ────────────────────────────────────────────
 * Each section is a separate endpoint with its own rules: repricing is refused on a sold
 * category, moving is refused if the screen is busy, cancelling is irreversible. A single
 * Save firing four requests would half-succeed and leave the operator working out which
 * half — the same failure the bulk scheduler dry-runs to avoid. Each change is committed on
 * its own and reports its own outcome.
 */
export function EditShowDialog({
  show,
  onClose,
  onChanged,
}: {
  show: ShowRow | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const sessionId = show?.sessionId ?? '';

  /** Local `datetime-local` value for an instant, in the reader's own zone. */
  const localValue = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const [startsAt, setStartsAt] = useState('');
  /** Rupees as typed, keyed by ticket type. Empty until pricing loads. */
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  const pricingQ = useQuery({
    queryKey: ['show-pricing', sessionId],
    queryFn: () => api.shows.pricing(sessionId),
    enabled: Boolean(sessionId),
  });

  /*
    Reset every time a different show is opened.

    Without this the dialog reopens holding the previous show's start time and prices, and
    the operator's first action is to overwrite tonight's 21:00 with yesterday's 18:00.
  */
  const openedSessionId = show?.sessionId;
  const openedStartsAt = show?.startsAt;
  useEffect(() => {
    if (!openedStartsAt) return;
    setStartsAt(localValue(openedStartsAt));
    setReason('');
    setConfirmCancel(false);
    // Keyed on the show's IDENTITY, not the row object: `showsQ` refetches after every
    // action and hands back a new object each time, which would wipe whatever the operator
    // had half-typed in the next section.
  }, [openedSessionId, openedStartsAt]);

  useEffect(() => {
    if (!pricingQ.data) return;
    setPrices(
      Object.fromEntries(
        pricingQ.data.categories.map((c) => [c.ticketTypeId, String(c.priceMinor / 100)]),
      ),
    );
  }, [pricingQ.data]);

  const done = (message: string) => {
    toast.push(message, 'success');
    onChanged();
  };
  const failed = (e: unknown) => toast.push(errorMessage(e), 'error');

  const move = useMutation({
    mutationFn: () => api.shows.reschedule(sessionId, new Date(startsAt).toISOString(), 20),
    onSuccess: () => {
      done('Showtime moved.');
      onClose();
    },
    onError: failed,
  });

  const reprice = useMutation({
    mutationFn: () =>
      api.shows.updatePricing(
        sessionId,
        (pricingQ.data?.categories ?? [])
          .filter((c) => !c.locked)
          .map((c) => ({
            ticketTypeId: c.ticketTypeId,
            priceMinor: Math.round(Number(prices[c.ticketTypeId] ?? 0) * 100),
          })),
      ),
    onSuccess: () => {
      done('Prices updated.');
      pricingQ.refetch();
    },
    onError: failed,
  });

  const pause = useMutation({
    mutationFn: () => api.shows.pause(sessionId, reason || undefined),
    onSuccess: () => {
      done('Sales paused. The show is still on.');
      onClose();
    },
    onError: failed,
  });

  const reopen = useMutation({
    mutationFn: () => api.shows.reopen(sessionId, reason || undefined),
    onSuccess: () => {
      done('Back on sale.');
      onClose();
    },
    onError: failed,
  });

  const cancel = useMutation({
    mutationFn: () => api.shows.cancel(sessionId, reason),
    onSuccess: (result) => {
      /*
        Cancelling does NOT refund anybody, and saying "cancelled" alone would let an
        operator believe it had. The count of bookings still owed a refund is the only
        honest thing to report.
      */
      const owed = result.bookingsRequiringRefund.length;
      toast.push(
        owed === 0
          ? 'Show cancelled. Nobody had booked.'
          : `Show cancelled. ${owed} booking${owed === 1 ? '' : 's'} still need refunding — nobody has been refunded yet.`,
        owed === 0 ? 'success' : 'error',
      );
      onChanged();
      onClose();
    },
    onError: failed,
  });

  const busy =
    move.isPending || reprice.isPending || pause.isPending || reopen.isPending || cancel.isPending;

  const paused = show?.status === 'PAUSED';
  const inThePast = show ? new Date(show.startsAt) <= new Date() : false;

  return (
    <Dialog
      open={show !== null}
      onClose={onClose}
      size="lg"
      title={show ? `Edit the ${new Date(show.startsAt).toLocaleString()} show` : 'Edit show'}
      footer={
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Done
        </Button>
      }
    >
      {show ? (
        <div className="space-y-6">
          {show.seatsSold > 0 && (
            <p className="rounded-md border border-status-warning/30 bg-status-warning/5 p-3 text-caption">
              <strong>{show.seatsSold}</strong> {show.seatsSold === 1 ? 'seat is' : 'seats are'}{' '}
              already sold. Everyone who booked keeps their seat — whatever you change here, tell
              them.
            </p>
          )}

          <section className="space-y-3">
            <h3 className="text-[0.9375rem] font-semibold text-text-primary">When it plays</h3>
            <DateTimeField
              id="edit-show-start"
              label="Start time"
              value={startsAt}
              min={localValue(new Date().toISOString())}
              onChange={setStartsAt}
            />
            <p className="text-caption text-text-muted">
              The end time moves with it, from the film&rsquo;s runtime. The screen must be free,
              with the usual turnaround either side.
            </p>
            <Button
              size="sm"
              loading={move.isPending}
              disabled={busy || !startsAt || inThePast}
              onClick={() => move.mutate()}
            >
              Move it
            </Button>
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="text-[0.9375rem] font-semibold text-text-primary">What it charges</h3>
            {pricingQ.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (pricingQ.data?.categories.length ?? 0) === 0 ? (
              <p className="text-caption text-text-muted">
                This show has no seat categories to price.
              </p>
            ) : (
              <>
                <div className="space-y-3">
                  {pricingQ.data!.categories.map((c) => (
                    <div key={c.ticketTypeId} className="grid gap-2 sm:grid-cols-2 sm:items-end">
                      <Input
                        id={`price-${c.ticketTypeId}`}
                        label={`${c.name} (₹)`}
                        type="number"
                        min={0}
                        value={prices[c.ticketTypeId] ?? ''}
                        disabled={c.locked}
                        /*
                          A sold seat fixes the price for this show and nothing else does.
                          Locked rather than hidden: the operator asked what this category
                          charges, and the answer is still the answer.
                        */
                        hint={
                          c.locked
                            ? `Fixed at ${money(c.priceMinor, c.currency)} — ${c.soldCount} sold`
                            : `${c.seatCount} seats`
                        }
                        onChange={(e) =>
                          setPrices((p) => ({ ...p, [c.ticketTypeId]: e.target.value }))
                        }
                      />
                    </div>
                  ))}
                </div>
                <Button
                  size="sm"
                  loading={reprice.isPending}
                  disabled={busy || pricingQ.data!.categories.every((c) => c.locked)}
                  onClick={() => reprice.mutate()}
                >
                  Update prices
                </Button>
              </>
            )}
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="text-[0.9375rem] font-semibold text-text-primary">
              {paused ? 'Currently off sale' : 'On sale'}
            </h3>
            <p className="text-caption text-text-muted">
              {paused
                ? 'Nobody can book this show. It has not been cancelled and everyone who already booked still has their seat.'
                : 'Pausing stops new bookings without cancelling anything — useful while you sort out a projector or a price.'}
            </p>
            <Input
              id="show-reason"
              label="Reason (optional)"
              placeholder="e.g. projector fault"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {paused ? (
              <Button
                size="sm"
                variant="outline"
                loading={reopen.isPending}
                disabled={busy}
                onClick={() => reopen.mutate()}
              >
                Put it back on sale
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                loading={pause.isPending}
                disabled={busy}
                onClick={() => pause.mutate()}
              >
                Stop selling
              </Button>
            )}
          </section>

          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="text-[0.9375rem] font-semibold text-status-error">Cancel this show</h3>
            <p className="text-caption text-text-muted">
              {/*
                Said plainly because the API does not refund, and an operator who assumes it
                does will not run the refunds — which is money owed to real people.
              */}
              This cannot be undone, and it does <strong>not</strong> refund anybody. Any bookings
              will be listed for the refund workflow afterwards.
            </p>
            {confirmCancel ? (
              <div className="space-y-3 rounded-md border border-status-error/30 bg-status-error/5 p-3">
                <p className="text-caption">
                  A reason is required — it goes in the audit log and into what the customer is
                  told.
                </p>
                <Input
                  id="cancel-reason"
                  label="Why is it cancelled?"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirmCancel(false)}
                  >
                    Keep the show
                  </Button>
                  <Button
                    size="sm"
                    className="bg-status-error text-white hover:bg-status-error/90"
                    loading={cancel.isPending}
                    disabled={busy || reason.trim().length === 0}
                    onClick={() => cancel.mutate()}
                  >
                    Cancel the show
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="text-status-error"
                disabled={busy}
                onClick={() => setConfirmCancel(true)}
              >
                Cancel this show
              </Button>
            )}
          </section>
        </div>
      ) : null}
    </Dialog>
  );
}
