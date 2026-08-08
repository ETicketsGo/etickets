'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Badge,
  Button,
  Dialog,
  Input,
  Select,
  Textarea,
  errorMessage,
  useToast,
  type LiveSeat,
  type SeatOverrideKind,
} from '@eticketsgo/web-kit';
import {
  describeExpiry,
  explainOverrideCode,
  formatLocalTime,
  HOUSE_PURPOSES,
  OVERRIDE_KINDS,
  OVERRIDE_LABEL,
  OVERRIDE_TONE,
  seatActions,
} from './seat-presentation';

/**
 * Inspect one seat and change its state.
 *
 * ── NOTHING IS OPTIMISTIC ─────────────────────────────────────────────────────────
 * The map is never updated before the server confirms. Refusal is a NORMAL outcome here —
 * the seat may have sold in the seconds since the map was drawn — so painting the change
 * first would routinely show an operator a block that did not happen.
 *
 * ── A REASON IS MANDATORY ─────────────────────────────────────────────────────────
 * Enforced here and again by the API. A block nobody can explain is a seat nobody dares
 * release, and it stays dead for the whole run of the film.
 */
export function SeatOverrideDialog({
  seat,
  sessionId,
  timezone,
  onClose,
  onApplied,
}: {
  seat: LiveSeat;
  sessionId: string;
  timezone: string;
  onClose: () => void;
  /** Re-reads the authoritative seat map and occupancy. */
  onApplied: () => void;
}) {
  const toast = useToast();
  const actions = seatActions(seat);
  const isBlocked = seat.status === 'BLOCKED';

  const [kind, setKind] = useState<SeatOverrideKind>(seat.overrideKind ?? 'MANUAL_BLOCK');
  const [housePurpose, setHousePurpose] = useState<string>('COMPLIMENTARY');
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [forceRelease, setForceRelease] = useState(false);

  const now = new Date();
  const expiryNote = describeExpiry(seat.overrideExpiresAt, now, timezone);
  const reasonMissing = reason.trim().length < 3;

  /** Both mutations share this: the API answers per seat, so a refusal is not an exception. */
  const handleResult = (result: {
    applied: number;
    seats: { code?: string; reason?: string }[];
    warnings: string[];
  }) => {
    if (result.applied === 0) {
      const first = result.seats[0];
      setError(explainOverrideCode(first?.code, first?.reason));
      // Refresh anyway: a refusal usually means the seat moved on, and the operator needs
      // to be looking at the truth rather than the state they clicked from.
      onApplied();
      return;
    }
    for (const w of result.warnings) toast.push(w, 'info');
    toast.push('Seat updated.', 'success');
    onApplied();
    onClose();
  };

  const block = useMutation({
    mutationFn: () =>
      api.theaterOps.blockSeats(sessionId, {
        seatIds: [seat.seatId],
        kind,
        reason: reason.trim(),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        housePurpose: kind === 'HOUSE' ? (housePurpose as never) : undefined,
      }),
    onSuccess: handleResult,
    onError: (e) => setError(errorMessage(e)),
  });

  const release = useMutation({
    mutationFn: () =>
      api.theaterOps.releaseSeats(sessionId, {
        seatIds: [seat.seatId],
        reason: reason.trim(),
        force: forceRelease || undefined,
      }),
    onSuccess: handleResult,
    onError: (e) => setError(errorMessage(e)),
  });

  const busy = block.isPending || release.isPending;

  return (
    <Dialog open onClose={onClose} title={`Seat ${seat.label}`}>
      <div className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-text-muted">Status</dt>
          <dd>
            <Badge tone={seat.overrideKind ? OVERRIDE_TONE[seat.overrideKind] : 'neutral'}>
              {seat.overrideKind ? OVERRIDE_LABEL[seat.overrideKind] : seat.status}
            </Badge>
          </dd>
          {seat.kind !== 'SEAT' ? (
            <>
              <dt className="text-text-muted">Seat type</dt>
              <dd>{seat.kind === 'WHEELCHAIR' ? 'Wheelchair space' : seat.kind.toLowerCase()}</dd>
            </>
          ) : null}
          {seat.overrideReason ? (
            <>
              <dt className="text-text-muted">Reason</dt>
              <dd>{seat.overrideReason}</dd>
            </>
          ) : null}
          {seat.overrideBy ? (
            <>
              <dt className="text-text-muted">Set by</dt>
              <dd>
                {seat.overrideBy}
                {seat.overrideAt ? ` at ${formatLocalTime(seat.overrideAt, timezone)}` : ''}
              </dd>
            </>
          ) : null}
          {expiryNote ? (
            <>
              <dt className="text-text-muted">Expiry</dt>
              <dd>{expiryNote}</dd>
            </>
          ) : null}
        </dl>

        {!actions.block && !actions.release ? (
          /*
            Sold, or a live checkout. Explaining WHY there is nothing to do beats an empty
            dialog — and the sold case names the two honest alternatives rather than just
            refusing.
          */
          <p className="rounded-md bg-background-subtle p-3 text-sm" role="note">
            {seat.status === 'SOLD'
              ? 'This seat has already been sold and cannot be changed. Cancel the show or refund the booking instead.'
              : 'This seat is currently held by a customer. Try again after the hold expires.'}
          </p>
        ) : (
          <>
            {isBlocked ? null : (
              <div>
                <label htmlFor="ov-kind" className="mb-1 block text-sm font-medium">
                  Withdraw because
                </label>
                <Select
                  id="ov-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as SeatOverrideKind)}
                >
                  {OVERRIDE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {OVERRIDE_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {!isBlocked && kind === 'HOUSE' ? (
              <div>
                <label htmlFor="ov-purpose" className="mb-1 block text-sm font-medium">
                  House seat purpose
                </label>
                <Select
                  id="ov-purpose"
                  value={housePurpose}
                  onChange={(e) => setHousePurpose(e.target.value)}
                >
                  {HOUSE_PURPOSES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}

            {!isBlocked && kind === 'MAINTENANCE' ? (
              <div>
                <label htmlFor="ov-expiry" className="mb-1 block text-sm font-medium">
                  Return to sale at (optional)
                </label>
                <Input
                  id="ov-expiry"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
                {/*
                  Precise about what expiry does. An operator must not read this as a promise
                  that a seat somebody has since bought will be taken back off them.
                */}
                <p className="mt-1 text-caption text-text-muted">
                  Expiry automatically returns the seat to service if it is still safe to do so. A
                  seat that has been sold or is being checked out is never disturbed.
                </p>
              </div>
            ) : null}

            <div>
              <label htmlFor="ov-reason" className="mb-1 block text-sm font-medium">
                Reason <span aria-hidden>*</span>
                <span className="sr-only">(required)</span>
              </label>
              <Textarea
                id="ov-reason"
                rows={2}
                value={reason}
                required
                onChange={(e) => setReason(e.target.value)}
                placeholder={isBlocked ? 'e.g. engineer signed it off' : 'e.g. broken recliner'}
              />
            </div>

            {isBlocked && seat.overrideKind === 'EMERGENCY' ? (
              <label className="flex items-start gap-2 rounded-md bg-status-error/10 p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={forceRelease}
                  onChange={(e) => setForceRelease(e.target.checked)}
                />
                <span>
                  This is an emergency block. I confirm it is safe to put this seat back on sale.
                </span>
              </label>
            ) : null}
          </>
        )}

        {error ? (
          // role=alert so a refusal is announced, not only painted.
          <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {actions.release ? (
            <Button
              variant="secondary"
              loading={release.isPending}
              disabled={
                busy || reasonMissing || (seat.overrideKind === 'EMERGENCY' && !forceRelease)
              }
              onClick={() => {
                setError(null);
                release.mutate();
              }}
            >
              Release seat
            </Button>
          ) : null}
          {actions.block ? (
            <Button
              loading={block.isPending}
              disabled={busy || reasonMissing}
              onClick={() => {
                setError(null);
                block.mutate();
              }}
            >
              {isBlocked ? 'Update block' : 'Withdraw seat'}
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
