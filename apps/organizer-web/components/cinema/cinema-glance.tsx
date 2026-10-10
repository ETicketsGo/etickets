'use client';

import Link from 'next/link';
import { ArrowRight, Building2, Clock } from 'lucide-react';
import { IconTile, ProgressMeter } from '@eticketsgo/web-kit';
import {
  formatClock,
  zoneShort,
  type CinemaGlance as Glance,
  type SaleVerdict,
} from './cinema-model';
import { SalePill } from './sale-pill';

/**
 * Today and the coming week at each cinema, built from the showtimes already loaded.
 *
 * The questions a cinema manager opens the console with: how many shows today, how full, what
 * is next, and can people actually buy. Every figure is a sum of the shows' own sold and seat
 * counts from the API; nothing is estimated.
 */
export function CinemaGlanceStrip({
  glances,
  verdictOf,
  limit = 6,
}: {
  glances: Glance[];
  /** The server's unified answer for each cinema, in words. */
  verdictOf: (cinemaId: string) => SaleVerdict;
  limit?: number;
}) {
  if (glances.length === 0) return null;
  const shown = glances.slice(0, limit);
  return (
    <section aria-labelledby="glance-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="glance-heading"
          className="font-display text-[1.0625rem] font-bold text-text-primary"
        >
          This week at your cinemas
        </h2>
        {glances.length > limit ? (
          <Link
            href="/organizer/venues"
            className="inline-flex items-center gap-1 rounded-sm text-ui font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            All {glances.length} cinemas <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        ) : null}
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((g) => (
          <li
            key={g.cinemaId}
            className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-background-surface p-4 shadow-xs sm:p-5"
          >
            <div className="flex min-w-0 items-start gap-3">
              <IconTile icon={Building2} tone="blue" />
              <div className="min-w-0 flex-1">
                <h3 className="line-clamp-2 break-words text-[0.9375rem] font-semibold leading-snug text-text-primary">
                  {g.cinemaName}
                </h3>
                <div className="mt-1.5">
                  <SalePill verdict={verdictOf(g.cinemaId)} size="sm" wrap />
                </div>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-4">
              <div className="min-w-0">
                <dt className="text-caption text-text-muted">Today</dt>
                <dd className="font-display text-[1.375rem] font-bold leading-tight tabular-nums text-text-primary">
                  {g.today.shows}
                  <span className="ml-1 font-sans text-caption font-normal text-text-muted">
                    {g.today.shows === 1 ? 'show' : 'shows'}
                  </span>
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-caption text-text-muted">Next 7 days</dt>
                <dd className="font-display text-[1.375rem] font-bold leading-tight tabular-nums text-text-primary">
                  {g.week.shows}
                  <span className="ml-1 font-sans text-caption font-normal text-text-muted">
                    {g.week.shows === 1 ? 'show' : 'shows'}
                  </span>
                </dd>
              </div>
            </dl>
            {g.week.total > 0 ? (
              <ProgressMeter
                value={g.week.sold}
                max={g.week.total}
                size="sm"
                unit="seats sold this week"
                label={`Seats sold in the next 7 days at ${g.cinemaName}`}
              />
            ) : null}
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-caption">
              <span className="flex min-w-0 items-center gap-1.5 text-text-secondary">
                <Clock className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden />
                {g.nextToday ? (
                  <span className="min-w-0 break-words">
                    Next today{' '}
                    <span className="font-semibold tabular-nums text-text-primary">
                      {formatClock(g.nextToday.startsAt, g.timeZone)}
                    </span>{' '}
                    {zoneShort(g.nextToday.startsAt, g.timeZone)} - {g.nextToday.movieTitle}
                  </span>
                ) : (
                  'Nothing more today'
                )}
              </span>
              <Link
                href={`/organizer/cinemas/${g.cinemaId}/schedule`}
                aria-label={`Open the schedule for ${g.cinemaName}`}
                className="inline-flex items-center gap-1 rounded-sm font-medium text-action-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Schedule
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
