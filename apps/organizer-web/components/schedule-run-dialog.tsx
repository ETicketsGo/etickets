'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarRange, Check, X, Plus } from 'lucide-react';
import { api, Button, Dialog, Input, Select, errorMessage } from '@eticketsgo/web-kit';

/**
 * Scheduling a run — a week of a film in one pass instead of twenty-eight forms.
 *
 * ── THE PROBLEM THIS EXISTS FOR ────────────────────────────────────────────────────
 * A film opens on Friday and plays for a week, four times a day. That is twenty-eight
 * showtimes, and the console only offered "Schedule show", once, with a date and a time.
 * An organizer reported it exactly that way: hard to create 7×4 shows one at a time. The
 * API has had `shows/bulk` all along — a date range, a list of daily times, and a dry run.
 * Only the screen was missing.
 *
 * ── WHY THE PREVIEW IS NOT OPTIONAL ────────────────────────────────────────────────
 * Twenty-eight shows is twenty-eight chances to collide with something already on that
 * screen, and a batch that half-succeeds is worse than one that refuses: the operator has
 * to work out which half. So this ALWAYS dry-runs first. The organizer sees every decision
 * — what would be created, what conflicts and with how little room — and only then commits.
 * The button says how many it will create, because "Schedule" over a list with four
 * conflicts in it is a promise the batch cannot keep.
 */

/** Times an organizer is likely to want, offered as one tap each. */
const COMMON_TIMES = ['10:00', '11:30', '13:00', '14:30', '16:00', '18:00', '19:30', '21:30'];

/** Monday-first, because a cinema week is planned that way. */
const DAYS = [
  { key: 1, short: 'Mon' },
  { key: 2, short: 'Tue' },
  { key: 3, short: 'Wed' },
  { key: 4, short: 'Thu' },
  { key: 5, short: 'Fri' },
  { key: 6, short: 'Sat' },
  { key: 0, short: 'Sun' },
];

/** Local calendar date as YYYY-MM-DD, with no UTC round trip to shift the day. */
function todayLocal(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Every date in an inclusive range, filtered to the chosen weekdays. */
function datesInRange(from: string, to: string, weekdays: Set<number>): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const cursor = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  // Capped at the API's own limit, so an accidental year-long range is refused here with
  // something readable rather than by a validation error after the fact.
  while (cursor <= end && out.length < 62) {
    if (weekdays.has(cursor.getDay())) {
      out.push(
        [
          cursor.getFullYear(),
          String(cursor.getMonth() + 1).padStart(2, '0'),
          String(cursor.getDate()).padStart(2, '0'),
        ].join('-'),
      );
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** What the server said about one proposed showtime it would not create. */
interface Rejected {
  startsAt: string;
  endsAt: string;
  reason: string;
  gapMinutes?: number;
}

/**
 * Plain English for a machine reason. An operator should not have to decode an enum.
 *
 * `gapMinutes` is NEGATIVE when the two windows genuinely overlap, which is documented and
 * correct — but rendering it literally produced "only -116 min between them", a sentence
 * that means nothing to somebody trying to fix a schedule.
 */
function explain(r: Rejected): string {
  const gap = r.gapMinutes;
  const clash =
    gap === undefined
      ? 'Clashes with a show already on this screen'
      : gap < 0
        ? `Overlaps a show already on this screen by ${Math.abs(gap)} min`
        : `Too close to a show already on this screen — ${gap} min between them`;
  switch (r.reason) {
    case 'OVERLAPS_EXISTING_SHOW':
      return clash;
    case 'OVERLAPS_PROPOSED_SHOW':
      return 'Clashes with another showtime in this batch';
    case 'DUPLICATE_IN_REQUEST':
      return 'The same time twice in this batch';
    case 'IN_THE_PAST':
      return 'Already in the past';
    case 'ENDS_BEFORE_IT_STARTS':
      return 'Ends before it starts';
    default:
      return r.reason;
  }
}

export interface ScheduleRunDialogProps {
  open: boolean;
  onClose: () => void;
  movieId: string;
  cinemas: { id: string; name: string }[];
  /** Refresh the shows table once something has actually been written. */
  onScheduled: () => void;
}

export function ScheduleRunDialog({
  open,
  onClose,
  movieId,
  cinemas,
  onScheduled,
}: ScheduleRunDialogProps) {
  /*
    Its own cinema and screen, rather than borrowing the single-show dialog's.

    That state only fills in once somebody has opened the other dialog and chosen there, so
    reusing it would make "Schedule a run" work or not depending on what the organizer had
    clicked earlier — which is the sort of thing that reads as a bug even when it is
    explainable.
  */
  const [chosenCinema, setChosenCinema] = useState('');
  const [screenId, setScreenId] = useState('');

  /*
    Defaulted by falling back, not by initialising state.

    `useState(cinemas[0]?.id)` captures whatever the list held on the FIRST render — and the
    cinemas are still loading then, so it captured an empty string and never revisited it.
    The screen dropdown then said "this cinema has no screens" about a cinema with six,
    because no cinema had been chosen at all.
  */
  const cinemaId = chosenCinema || cinemas[0]?.id || '';

  const screensQ = useQuery({
    queryKey: ['cinema', cinemaId, 'screens'],
    queryFn: () => api.cinemas.screens(cinemaId),
    enabled: open && !!cinemaId,
  });
  const screens = screensQ.data ?? [];
  const [from, setFrom] = useState(() => todayLocal(1));
  const [to, setTo] = useState(() => todayLocal(7));
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4, 5, 6]));
  const [times, setTimes] = useState<string[]>(['14:30', '18:00', '21:30']);
  const [custom, setCustom] = useState('');
  const [padMinutes, setPadMinutes] = useState('20');
  const [error, setError] = useState<string | null>(null);

  const dates = useMemo(() => datesInRange(from, to, weekdays), [from, to, weekdays]);
  const planned = dates.length * times.length;

  /*
    The preview and the commit are the SAME call, differing only in `dryRun`.

    Any other arrangement lets the two drift — a preview computed by the client would be a
    second opinion about conflicts, and the moment it disagreed with the server the operator
    would trust the wrong one.
  */
  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.shows.bulkSchedule(movieId, {
        screenId,
        dates,
        times,
        padMinutes: Number(padMinutes) || 0,
        dryRun,
      }),
    onError: (e) => setError(errorMessage(e)),
  });

  const preview = run.data;
  // A preview describes the settings it was run against; changing anything invalidates it.
  const previewIsStale = run.variables === false;

  const toggleTime = (t: string) =>
    setTimes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t].sort()));

  const addCustom = () => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(custom)) return;
    setTimes((prev) => (prev.includes(custom) ? prev : [...prev, custom].sort()));
    setCustom('');
  };

  const reset = () => {
    run.reset();
    setError(null);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Schedule a run"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          {!preview || previewIsStale ? (
            <Button
              loading={run.isPending}
              disabled={planned === 0 || !screenId}
              onClick={() => {
                setError(null);
                run.mutate(true);
              }}
            >
              Preview {planned} show{planned === 1 ? '' : 's'}
            </Button>
          ) : (
            <Button
              loading={run.isPending}
              disabled={preview.creatable.length === 0}
              onClick={() =>
                run.mutate(false, {
                  onSuccess: () => {
                    onScheduled();
                    onClose();
                  },
                })
              }
            >
              {/*
                The count is on the button because a batch with conflicts in it creates
                FEWER than were planned, and "Schedule" over such a list is a promise it
                cannot keep.
              */}
              Create {preview.creatable.length} show{preview.creatable.length === 1 ? '' : 's'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        {/*
          The answer sits ABOVE the question.

          It used to be the last thing in a scrolling panel, so clicking Preview on a week
          that entirely clashes left "Create 0 shows" disabled at the bottom of the dialog
          with the reason out of sight below the fold. The operator is told what happened
          where they are already looking.
        */}
        {preview && !previewIsStale ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              {/*
                Both numbers, always. A preview that only reports successes lets an
                operator hit Create believing the batch is whole.
              */}
              {preview.creatable.length} will be created
              {preview.rejected.length > 0 ? `, ${preview.rejected.length} cannot` : ''}
              <span className="ml-2 font-normal text-text-muted">
                times shown in {preview.timezone}
              </span>
            </p>

            {preview.rejected.length > 0 ? (
              <ul className="max-h-48 space-y-1 overflow-auto rounded-md border border-border p-2">
                {preview.rejected.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-caption">
                    <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-error" />
                    <span>
                      {/*
                        In the VENUE's zone, which the response tells us, not the reader's.

                        A browser in London formatting an Indian 14:30 show renders 09:00,
                        and an operator reading a conflict list of times that are not the
                        times they typed has no way to act on it. This product has shipped
                        that mistake before.
                      */}
                      <span className="tabular-nums">
                        {new Date(r.startsAt).toLocaleString(undefined, {
                          day: 'numeric',
                          month: 'short',
                          hour: 'numeric',
                          minute: '2-digit',
                          timeZone: preview.timezone,
                        })}
                      </span>
                      <span className="text-text-muted"> — {explain(r)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 text-caption text-status-success">
                <Check className="h-3.5 w-3.5" />
                Every showtime fits on this screen.
              </p>
            )}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="run-cinema" className="mb-1 block text-sm font-medium">
              Cinema
            </label>
            <Select
              id="run-cinema"
              value={cinemaId}
              onChange={(e) => {
                setChosenCinema(e.target.value);
                setScreenId('');
                reset();
              }}
            >
              {cinemas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="run-screen" className="mb-1 block text-sm font-medium">
              Screen
            </label>
            <Select
              id="run-screen"
              value={screenId}
              disabled={screensQ.isLoading || screens.length === 0}
              onChange={(e) => {
                setScreenId(e.target.value);
                reset();
              }}
            >
              <option value="">
                {screensQ.isLoading
                  ? 'Loading…'
                  : screens.length === 0
                    ? 'This cinema has no screens'
                    : 'Pick a screen'}
              </option>
              {screens.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="run-pad" className="mb-1 block text-sm font-medium">
              Trailers &amp; turnaround (min)
            </label>
            <Input
              id="run-pad"
              type="number"
              min="0"
              max="120"
              value={padMinutes}
              onChange={(e) => {
                setPadMinutes(e.target.value);
                reset();
              }}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="run-from" className="mb-1 block text-sm font-medium">
              First day
            </label>
            <Input
              id="run-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                reset();
              }}
            />
          </div>
          <div>
            <label htmlFor="run-to" className="mb-1 block text-sm font-medium">
              Last day
            </label>
            <Input
              id="run-to"
              type="date"
              value={to}
              min={from}
              onChange={(e) => {
                setTo(e.target.value);
                reset();
              }}
            />
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium">Days</p>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d) => {
              const on = weekdays.has(d.key);
              return (
                <button
                  key={d.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setWeekdays((prev) => {
                      const next = new Set(prev);
                      if (next.has(d.key)) next.delete(d.key);
                      else next.add(d.key);
                      return next;
                    });
                    reset();
                  }}
                  className={`rounded-md border px-2.5 py-1 text-caption transition-colors ${
                    on
                      ? 'border-action-primary bg-action-primary text-action-primary-foreground'
                      : 'border-border text-text-secondary hover:bg-background-subtle'
                  }`}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
          {/*
            A run that skips Mondays is an ordinary thing — a screen goes dark for
            maintenance, or a film only plays weekends. Expressing it as "the whole week
            minus Monday" is what an operator means; making them list twenty-four dates is
            not.
          */}
          <p className="mt-1 text-caption text-text-muted">
            {dates.length} day{dates.length === 1 ? '' : 's'} in this range
          </p>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium">Times, every day</p>
          <div className="flex flex-wrap gap-1.5">
            {[...new Set([...COMMON_TIMES, ...times])].sort().map((t) => {
              const on = times.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    toggleTime(t);
                    reset();
                  }}
                  className={`rounded-md border px-2.5 py-1 text-caption tabular-nums transition-colors ${
                    on
                      ? 'border-action-primary bg-action-primary text-action-primary-foreground'
                      : 'border-border text-text-secondary hover:bg-background-subtle'
                  }`}
                >
                  {t}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              id="run-custom"
              aria-label="Another time"
              placeholder="e.g. 07:45"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustom();
                  reset();
                }
              }}
              className="w-32"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                addCustom();
                reset();
              }}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>

        <div className="rounded-md border border-border bg-background-subtle p-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-text-primary">
            <CalendarRange className="h-4 w-4 text-text-muted" />
            {dates.length} day{dates.length === 1 ? '' : 's'} × {times.length} time
            {times.length === 1 ? '' : 's'} = {planned} show{planned === 1 ? '' : 's'}
          </p>
          {planned > 62 * 24 ? (
            <p className="mt-1 text-caption text-status-error">
              That is more than one batch can create. Narrow the range.
            </p>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="rounded-md bg-status-error/10 p-3 text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
