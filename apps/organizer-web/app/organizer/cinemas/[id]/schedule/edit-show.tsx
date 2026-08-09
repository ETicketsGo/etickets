'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, Button, Dialog, Input, useToast, type ShowRow } from '@eticketsgo/web-kit';
import { explainMutationError, localDateParts } from './show-status';

/**
 * Move a future show to a new time.
 *
 * ── WHY TIME ONLY ─────────────────────────────────────────────────────────────────
 * The backend's edit endpoint is `POST /shows/:id/reschedule` and it accepts a start time
 * and a padding value — nothing else. Its policy module also describes an EDIT_SCREEN rule,
 * but no endpoint exposes it, so there is no safe way to move a show between screens and
 * this dialog does not pretend otherwise. Offering a screen picker that always failed, or
 * quietly cancelling and recreating the session behind the operator's back, would both be
 * worse than saying it is not supported.
 *
 * The end time is not asked for. It is derived server-side from the film's runtime, so a
 * slot can never disagree with the length of what is being shown.
 *
 * Nothing moves on the schedule until the server says so. An optimistic move would show the
 * show at a time it may be refused for — and refusal is the common case here, because the
 * whole point of the guards is that a booked show cannot be moved.
 */
export function EditShowDialog({
  show,
  timezone,
  onClose,
  onSaved,
}: {
  show: ShowRow;
  /** The cinema's IANA zone. Never the browser's — see the schedule page. */
  timezone: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const current = localDateParts(show.startsAt, timezone);
  const [date, setDate] = useState(current.date);
  const [time, setTime] = useState(current.time);
  const [error, setError] = useState<string | null>(null);

  const unchanged = date === current.date && time === current.time;

  const save = useMutation({
    mutationFn: () => {
      /**
       * The operator types wall-clock time at the cinema; the server is told an instant.
       *
       * Converting through `new Date('YYYY-MM-DDTHH:mm')` would resolve against the
       * BROWSER's zone, so a manager in London moving a Hyderabad show to 18:00 would set
       * it to 23:30 local. The offset is derived for that specific date via Intl rather
       * than assumed, so a DST market stays correct too.
       */
      const startsAt = wallClockToInstant(date, time, timezone);
      return api.shows.reschedule(show.sessionId, startsAt.toISOString(), 0);
    },
    onSuccess: () => {
      toast.push('Show moved.', 'success');
      onSaved();
    },
    onError: (e) => {
      // Shown inside the dialog rather than as a toast: the operator needs it next to the
      // field they must change, and most of these are refusals they can act on.
      setError(explainMutationError(e));
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Move show"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            // Disabled while pending so a double-click cannot fire two reschedules, and
            // disabled when nothing changed so a no-op cannot spend a request.
            disabled={save.isPending || unchanged}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-text-muted">Movie</dt>
          <dd className="font-medium">{show.movieTitle ?? 'Untitled'}</dd>
          <dt className="text-text-muted">Cinema</dt>
          <dd>{show.cinemaName ?? '—'}</dd>
          <dt className="text-text-muted">Screen</dt>
          <dd>{show.screenName ?? '—'}</dd>
          <dt className="text-text-muted">Currently</dt>
          <dd>
            {current.date} at {current.time}
          </dd>
        </dl>

        {/*
          Screens are not offered. The endpoint cannot move a show between them, and a
          picker that always failed would be worse than its absence.
        */}
        <p className="rounded-md bg-background-subtle p-2 text-caption text-text-muted">
          Times are local to the cinema ({timezone}). To move a show to a different screen, cancel
          it and schedule it on the other screen.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="edit-date" className="mb-1 block text-sm font-medium">
              New date
            </label>
            <Input
              id="edit-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="edit-time" className="mb-1 block text-sm font-medium">
              New start time
            </label>
            <Input
              id="edit-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
        </div>

        {error ? (
          // role=alert so the refusal is announced, not just painted.
          <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * A wall-clock date and time in a named zone, as an absolute instant.
 *
 * Mirrors the server's own conversion. The naive `new Date(\`${date}T${time}\`)` resolves
 * against whatever zone the browser happens to be in, which is the defect already fixed
 * once on the schedule page and must not come back through this dialog.
 */
function wallClockToInstant(date: string, time: string, timeZone: string): Date {
  const naive = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(naive);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asZone = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second'),
  );
  return new Date(naive.getTime() - (asZone - naive.getTime()));
}
