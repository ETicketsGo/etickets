'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  api,
  Button,
  DateTimeField,
  Dialog,
  Textarea,
  errorMessage,
  isComplete,
  useToast,
  type EventSession,
} from '@eticketsgo/web-kit';
import { instantToWallClock, wallClockToInstant } from '@/lib/zoned-time';

/**
 * Changing a date's time, and cancelling a date, for an event that is not a film.
 *
 * ── WHY THESE EXIST ────────────────────────────────────────────────────────────────
 * The Sessions page could only ADD a date. One typed on the wrong evening stayed there, on
 * sale, with no way to move it or take it off - a cinema show had both, an event had neither.
 *
 * ── WHEN THEY ARE OFFERED ──────────────────────────────────────────────────────────
 * Changing the time only for a date nobody has bought for or is buying for (the page decides,
 * from the same sold/held counts that lock its seating; the server applies the rule again): a
 * buyer chose that time and is owed a cancellation and a refund, not a quiet edit. Cancelling
 * is offered for any date still to come; with buyers, the show cancellation opens their
 * refunds and tells them.
 */

/** "Is this date still the organizer's to change?" - one rule for both buttons. */
export function sessionEditable(s: EventSession, now: number): boolean {
  if (s.status === 'CANCELLED' || s.status === 'COMPLETED') return false;
  return new Date(s.startsAt).getTime() > now;
}

export function EditSessionTimeDialog({
  eventId,
  session,
  zone,
  zoneNote,
  onClose,
}: {
  eventId: string;
  session: EventSession | null;
  /** The venue's zone: times are typed and read at the venue, never in the browser's zone. */
  zone: string;
  zoneNote: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ startsAt: '', endsAt: '' });
  useEffect(() => {
    if (session)
      setForm({
        startsAt: instantToWallClock(session.startsAt, zone),
        endsAt: instantToWallClock(session.endsAt, zone),
      });
  }, [session, zone]);

  const save = useMutation({
    mutationFn: () =>
      api.shows.retime(
        session!.id,
        wallClockToInstant(form.startsAt, zone).toISOString(),
        wallClockToInstant(form.endsAt, zone).toISOString(),
      ),
    onSuccess: () => {
      toast.push('Date changed.', 'success');
      qc.invalidateQueries({ queryKey: ['event', eventId] });
      onClose();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const complete = isComplete(form.startsAt) && isComplete(form.endsAt);
  const endBeforeStart = complete && form.endsAt <= form.startsAt;

  return (
    <Dialog
      open={session !== null}
      onClose={onClose}
      title="Change this date"
      description="Only possible before anyone has booked it."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Keep it as it is
          </Button>
          <Button
            loading={save.isPending}
            disabled={!complete || endBeforeStart}
            onClick={() => save.mutate()}
          >
            Save new time
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <DateTimeField
          id="edit-s"
          label="Starts at"
          value={form.startsAt}
          onChange={(v) => setForm((f) => ({ ...f, startsAt: v }))}
          timeZoneLabel={zoneNote}
        />
        <DateTimeField
          id="edit-e"
          label="Ends at"
          value={form.endsAt}
          relativeTo={form.startsAt}
          min={form.startsAt}
          onChange={(v) => setForm((f) => ({ ...f, endsAt: v }))}
          error={endBeforeStart ? 'End must be after start.' : undefined}
          timeZoneLabel={zoneNote}
        />
      </div>
    </Dialog>
  );
}

export function CancelSessionDialog({
  eventId,
  session,
  whenLabel,
  sold = 0,
  onClose,
}: {
  eventId: string;
  session: EventSession | null;
  whenLabel: string;
  /** Tickets sold for this date. With any, cancelling refunds their buyers. */
  sold?: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  useEffect(() => setReason(''), [session]);

  const cancel = useMutation({
    mutationFn: () => api.shows.cancel(session!.id, reason.trim()),
    onSuccess: (r) => {
      const owed = r.bookingsRequiringRefund?.length ?? 0;
      toast.push(
        owed > 0
          ? `Date cancelled. ${owed} ${owed === 1 ? 'buyer is' : 'buyers are'} owed a refund and will be told. Approve the refunds on Refunds.`
          : 'Date cancelled. It is no longer on sale.',
        'success',
      );
      qc.invalidateQueries({ queryKey: ['event', eventId] });
      onClose();
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  return (
    <Dialog
      open={session !== null}
      onClose={onClose}
      title="Cancel this date?"
      description={
        sold > 0
          ? `${whenLabel}. ${sold} ${sold === 1 ? 'ticket is' : 'tickets are'} sold for it. Each paid booking gets a refund request for the full amount, which you approve on Refunds, and every ticket holder is told by email. Cash taken at the counter is handed back there. This cannot be undone.`
          : `${whenLabel}. Nobody has booked it. Buyers will no longer see it. This cannot be undone.`
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Keep this date
          </Button>
          <Button
            variant="danger"
            loading={cancel.isPending}
            disabled={reason.trim().length < 3}
            onClick={() => cancel.mutate()}
          >
            {sold > 0 ? 'Cancel date and refund' : 'Cancel date'}
          </Button>
        </>
      }
    >
      <Textarea
        id="cancel-reason"
        label="Why (for your team's records)"
        rows={2}
        value={reason}
        placeholder="For example: added by mistake"
        onChange={(e) => setReason(e.target.value)}
      />
    </Dialog>
  );
}
