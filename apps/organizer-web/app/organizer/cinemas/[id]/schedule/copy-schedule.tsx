'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  Button,
  Dialog,
  Input,
  Select,
  errorMessage,
  useToast,
  type CopyScheduleResult,
  type Screen,
} from '@eticketsgo/web-kit';
import { explainRejection, formatDayHeading, shiftDate } from './show-status';

/** Every film on the source screen that day: the usual answer to "copy this day". */
const ALL_FILMS = '*';

/** One film's preview, kept with the film it belongs to. */
interface FilmPreview {
  movieId: string;
  title: string;
  result: CopyScheduleResult;
}

/**
 * Copy a screen's day to another date and/or screen.
 *
 * Preview first, always. Copying a full day is the fastest way to fill a schedule and
 * therefore the fastest way to fill it wrongly; the operator sees the recovered times and
 * any conflicts before anything is written.
 *
 * The server recovers the source times and re-resolves them against the target date in the
 * venue's zone, so a 10:30 show stays 10:30 even across a clock change. Nothing here does
 * date arithmetic on instants.
 *
 * ── WHAT CHANGED AFTER THE WALK (2026-10-15) ───────────────────────────────────────
 * - A preview described the settings it was run against, but changing the date afterwards
 *   kept it on screen and "Copy 2 shows" stayed live: it copied to a date nobody previewed.
 *   Any change now discards the preview.
 * - The operator had to pick one film from the whole library (drafts and ended films too),
 *   even when the day had one film - and a day with three films took three copies. The film
 *   list is now the films actually on that screen that day, and "All films on this day" is
 *   the default. The API copies one film at a time, so this asks it once per film.
 * - Refusals read as sentences and dates as dates; the machine codes are gone from the screen.
 */
export function CopyScheduleDialog({
  screens,
  sourceDate,
  timezone,
  cinemaId,
  onClose,
  onCopied,
}: {
  screens: Screen[];
  sourceDate: string;
  timezone: string;
  cinemaId: string;
  onClose: () => void;
  onCopied: () => void;
}) {
  const toast = useToast();
  // The source day's shows. The same query as the day view, so it is usually already cached;
  // asked here too because Copy is offered in the week view, where the day is not loaded.
  const dayQ = useQuery({
    queryKey: ['cinema', cinemaId, 'schedule', sourceDate, timezone],
    queryFn: () => api.shows.cinemaSchedule(cinemaId, sourceDate, timezone),
  });
  const dayRows = dayQ.data ?? [];
  // Start on a screen that has something to copy.
  const firstBusy = screens.find((s) => dayRows.some((r) => r.screenId === s.id));
  // Derived until chosen, because the day may still be loading on the first render.
  const [chosenSource, setSourceScreenId] = useState<string | null>(null);
  const sourceScreenId = chosenSource ?? firstBusy?.id ?? screens[0]?.id ?? '';
  const [targetScreenId, setTargetScreenId] = useState('');
  const [targetDate, setTargetDate] = useState(shiftDate(sourceDate, 7));
  const [film, setFilm] = useState(ALL_FILMS);
  const [previews, setPreviews] = useState<FilmPreview[] | null>(null);

  // The films on the chosen screen that day, once each, in the order they first play.
  const films = (() => {
    const seen = new Map<string, string>();
    for (const r of [...dayRows].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      if (r.screenId === sourceScreenId && r.movieId && r.status.toUpperCase() !== 'CANCELLED') {
        if (!seen.has(r.movieId)) seen.set(r.movieId, r.movieTitle ?? 'Untitled');
      }
    }
    return [...seen.entries()].map(([id, title]) => ({ id, title }));
  })();
  const chosen = film === ALL_FILMS ? films : films.filter((f) => f.id === film);

  const body = (dryRun: boolean) => ({
    sourceScreenId,
    sourceDate,
    ...(targetScreenId ? { targetScreenId } : {}),
    targetDate,
    timezone,
    dryRun,
  });

  const previewM = useMutation({
    mutationFn: async () =>
      Promise.all(
        chosen.map(async (f) => ({
          movieId: f.id,
          title: f.title,
          result: await api.shows.copySchedule(f.id, body(true)),
        })),
      ),
    onSuccess: setPreviews,
    onError: (e) => toast.push(errorMessage(e)),
  });

  const copyM = useMutation({
    // One film after another, so a refusal part way names the film it stopped at.
    mutationFn: async () => {
      let created = 0;
      for (const p of previews ?? []) {
        if (p.result.proposed - p.result.rejected.length === 0) continue;
        const r = await api.shows.copySchedule(p.movieId, body(false));
        created += r.created.length;
      }
      return created;
    },
    onSuccess: (created) => {
      toast.push(`Copied ${created} show${created === 1 ? '' : 's'}.`, 'success');
      onCopied();
    },
    onError: (e) => {
      toast.push(errorMessage(e));
      onCopied();
    },
  });

  const willCreate = (previews ?? []).reduce(
    (n, p) => n + p.result.proposed - p.result.rejected.length,
    0,
  );
  const skipped = (previews ?? []).reduce((n, p) => n + p.result.rejected.length, 0);

  return (
    <Dialog open onClose={onClose} title="Copy schedule">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="copy-source" className="mb-1 block text-sm font-medium">
              From screen
            </label>
            <Select
              id="copy-source"
              value={sourceScreenId}
              onChange={(e) => {
                setSourceScreenId(e.target.value);
                setFilm(ALL_FILMS);
                setPreviews(null);
              }}
            >
              {screens.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-text-muted">on {formatDayHeading(sourceDate)}</p>
          </div>
          <div>
            <label htmlFor="copy-target-screen" className="mb-1 block text-sm font-medium">
              To screen
            </label>
            <Select
              id="copy-target-screen"
              value={targetScreenId}
              onChange={(e) => {
                setTargetScreenId(e.target.value);
                setPreviews(null);
              }}
            >
              <option value="">Same screen</option>
              {screens
                .filter((s) => s.id !== sourceScreenId)
                .map((s) => (
                  <option
                    key={s.id}
                    value={s.id}
                    disabled={Boolean(s.status && s.status !== 'ACTIVE')}
                  >
                    {s.name}
                    {s.status && s.status !== 'ACTIVE' ? ` - ${s.status.toLowerCase()}` : ''}
                  </option>
                ))}
            </Select>
          </div>
          <div>
            <label htmlFor="copy-target-date" className="mb-1 block text-sm font-medium">
              To date
            </label>
            <Input
              id="copy-target-date"
              type="date"
              value={targetDate}
              onChange={(e) => {
                setTargetDate(e.target.value);
                setPreviews(null);
              }}
            />
          </div>
          <div>
            <label htmlFor="copy-movie" className="mb-1 block text-sm font-medium">
              Films
            </label>
            <Select
              id="copy-movie"
              value={film}
              disabled={films.length === 0}
              onChange={(e) => {
                setFilm(e.target.value);
                setPreviews(null);
              }}
            >
              <option value={ALL_FILMS}>
                {films.length === 0
                  ? 'Nothing on this screen that day'
                  : `All films on this day (${films.length})`}
              </option>
              {films.length > 1
                ? films.map((m) => (
                    <option key={m.id} value={m.id}>
                      Only {m.title}
                    </option>
                  ))
                : null}
            </Select>
          </div>
        </div>

        <p className="rounded-md bg-background-subtle p-2 text-xs text-text-secondary">
          This creates new shows at the same times and prices. Bookings on the source day are not
          moved or affected.
        </p>

        {previews ? (
          <div className="space-y-3">
            <div className="rounded-md bg-background-subtle p-3 text-sm" role="status">
              <div>
                <strong className="text-status-success">{willCreate}</strong>{' '}
                {willCreate === 1 ? 'show' : 'shows'} will be created on{' '}
                {formatDayHeading(targetDate)}
                {skipped ? (
                  <>
                    {', '}
                    <strong className="text-status-warning">{skipped}</strong> skipped
                  </>
                ) : null}
              </div>
              <ul className="mt-1 space-y-0.5 text-caption text-text-secondary">
                {previews.map((p) => (
                  <li key={p.movieId}>
                    {p.title}: <span className="tabular-nums">{p.result.times.join(', ')}</span>
                  </li>
                ))}
              </ul>
            </div>
            {skipped ? (
              <ul className="space-y-2">
                {previews.flatMap((p) =>
                  p.result.rejected.map((r, i) => (
                    <li
                      key={`${p.movieId}-${r.startsAt}-${i}`}
                      className="rounded-md border border-border bg-tint-warning p-2 text-sm"
                    >
                      {p.title}: {explainRejection(r, p.result.turnaroundMinutes, timezone)}
                    </li>
                  )),
                )}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={copyM.isPending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => previewM.mutate()}
            disabled={!sourceScreenId || chosen.length === 0 || previewM.isPending}
          >
            {previewM.isPending ? 'Checking...' : 'Preview'}
          </Button>
          <Button
            onClick={() => copyM.mutate()}
            disabled={!previews || willCreate === 0 || copyM.isPending}
          >
            {copyM.isPending
              ? 'Copying...'
              : `Copy ${willCreate} show${willCreate === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
