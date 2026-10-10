'use client';

import Link from 'next/link';
import { ArrowRight, Building2 } from 'lucide-react';
import { Meter } from '@eticketsgo/web-kit';
import {
  formatClock,
  percentSold,
  type CinemaGlance as Glance,
  type CinemaSaleState,
  type SaleVerdict,
} from './cinema-model';
import { SaleChip } from './sale-chip';

/** A cinema's verdict in the chip's words. */
export function cinemaVerdict(
  state: CinemaSaleState,
): Pick<SaleVerdict, 'label' | 'tone' | 'selling'> {
  switch (state.kind) {
    case 'SELLING':
      return { label: 'Selling', tone: 'success', selling: true };
    case 'NOT_SELLING':
      return { label: `Not selling: ${state.reason}`, tone: 'warning', selling: false };
    case 'PARTLY':
      return {
        label: `Not selling: ${state.reason} (some shows)`,
        tone: 'warning',
        selling: false,
      };
    case 'NO_SHOWS':
      return { label: 'No upcoming shows', tone: 'neutral', selling: false };
    default:
      return { label: 'Sale status not confirmed', tone: 'neutral', selling: false };
  }
}

/**
 * Today and the coming week at each cinema, built from the showtimes already loaded.
 *
 * The questions a cinema manager opens the console with: how many shows today, how full, what
 * is next, and can people actually buy. Every figure is a sum of the shows' own sold and seat
 * counts from the API; nothing is estimated.
 */
export function CinemaGlanceStrip({
  glances,
  stateOf,
  limit = 6,
}: {
  glances: Glance[];
  stateOf: (cinemaId: string) => CinemaSaleState;
  limit?: number;
}) {
  if (glances.length === 0) return null;
  const shown = glances.slice(0, limit);
  return (
    <section aria-labelledby="glance-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="glance-heading"
          className="text-title font-semibold tracking-tight text-text-primary"
        >
          This week at your cinemas
        </h2>
        {glances.length > limit ? (
          <Link
            href="/organizer/cinemas"
            className="rounded text-caption font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            All {glances.length} cinemas
          </Link>
        ) : null}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((g) => {
          const pct = percentSold(g.today.sold, g.today.total);
          const weekPct = percentSold(g.week.sold, g.week.total);
          return (
            <li
              key={g.cinemaId}
              className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-background-surface p-4"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-tint-primary text-action-primary">
                  <Building2 className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="line-clamp-2 break-words text-[0.9375rem] font-semibold text-text-primary">
                    {g.cinemaName}
                  </h3>
                  <SaleChip verdict={cinemaVerdict(stateOf(g.cinemaId))} className="mt-1" />
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-[0.875rem]">
                <div className="min-w-0">
                  <dt className="text-caption text-text-muted">Today</dt>
                  <dd className="font-semibold tabular-nums text-text-primary">
                    {g.today.shows} {g.today.shows === 1 ? 'show' : 'shows'}
                  </dd>
                  {g.today.total > 0 ? (
                    <dd className="mt-1 space-y-1">
                      <span className="block text-caption tabular-nums text-text-secondary">
                        {g.today.sold} of {g.today.total} seats{pct !== null ? ` (${pct}%)` : ''}
                      </span>
                      <Meter
                        value={g.today.sold}
                        max={g.today.total}
                        label={`Seats sold today at ${g.cinemaName}`}
                      />
                    </dd>
                  ) : null}
                </div>
                <div className="min-w-0">
                  <dt className="text-caption text-text-muted">Next 7 days</dt>
                  <dd className="font-semibold tabular-nums text-text-primary">
                    {g.week.shows} {g.week.shows === 1 ? 'show' : 'shows'}
                  </dd>
                  {g.week.total > 0 ? (
                    <dd className="mt-1 text-caption tabular-nums text-text-secondary">
                      {g.week.sold} of {g.week.total} seats
                      {weekPct !== null ? ` (${weekPct}%)` : ''}
                    </dd>
                  ) : null}
                </div>
              </dl>
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-caption">
                <span className="min-w-0 text-text-secondary">
                  {g.nextToday ? (
                    <>
                      Next today{' '}
                      <span className="font-semibold tabular-nums text-text-primary">
                        {formatClock(g.nextToday.startsAt, g.timeZone)}
                      </span>{' '}
                      <span className="break-words">{g.nextToday.movieTitle}</span>
                    </>
                  ) : (
                    'Nothing more today'
                  )}
                </span>
                <Link
                  href={`/organizer/cinemas/${g.cinemaId}/schedule`}
                  aria-label={`Open the schedule for ${g.cinemaName}`}
                  className="inline-flex items-center gap-1 rounded font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Schedule
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
