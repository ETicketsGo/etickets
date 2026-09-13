'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronLeft, Info } from 'lucide-react';
import {
  api as webKit,
  formatFor,
  type PublicShowRow,
  type PublicShowSummary,
} from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui';
import { useFormat } from '@/lib/format';

/** A time of day in the show's zone: "6:00 pm" in English, "18 h 00" in French. */
function clock(iso: string, timeZone: string, locale?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    ...(locale ? {} : { hour12: true }),
  };
  try {
    return new Intl.DateTimeFormat(locale ?? 'en-IN', { ...options, timeZone }).format(
      new Date(iso),
    );
  } catch {
    return new Intl.DateTimeFormat(locale ?? 'en-IN', options).format(new Date(iso));
  }
}

/** "Sun, 13 Sept 2026" in the show's zone. */
function day(iso: string, timeZone: string, locale?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  };
  try {
    return new Intl.DateTimeFormat(locale ?? 'en-IN', { ...options, timeZone }).format(
      new Date(iso),
    );
  } catch {
    return new Intl.DateTimeFormat(locale ?? 'en-IN', options).format(new Date(iso));
  }
}

/** Whether the reader's own zone differs from the show's, so the time needs its zone named. */
function readerIsElsewhere(timeZone: string): boolean {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone !== timeZone;
  } catch {
    return false;
  }
}

/**
 * Which show these seats are for.
 *
 * ── WHY THE PAGE NEEDED IT ─────────────────────────────────────────────────────────
 * The seat page used to open on "Select seats" and nothing else. A buyer who followed a shared
 * link, refreshed, or came back to the tab could not tell which film, cinema or day they were
 * choosing seats for — and every one of those is a reason to book the wrong show. This states
 * all of it before the map, in the CINEMA's zone (a 00:30 show is on the next day there,
 * whatever the reader's clock says), and names that zone when the reader is somewhere else.
 */
export function ShowHeader({ summary }: { summary: PublicShowSummary }) {
  const t = useTranslations('storefront.seats');
  const intlLocale = formatFor(useLocale()).locale;
  const { zoneAbbrev } = useFormat();

  const title = summary.movie?.title ?? summary.event.title;
  const backHref = summary.movie
    ? `/movies/${summary.movie.slug}`
    : `/events/${summary.event.slug}`;
  const place = [
    summary.cinema?.name ?? summary.venue.name,
    summary.screen?.name,
    summary.venue.city,
  ]
    .filter(Boolean)
    .join(' · ');
  const zone = readerIsElsewhere(summary.timeZone)
    ? ` ${zoneAbbrev(summary.startsAt, summary.timeZone)}`
    : '';
  const runtime = summary.movie
    ? t('runtime', {
        hours: Math.floor(summary.movie.runtimeMinutes / 60),
        minutes: summary.movie.runtimeMinutes % 60,
      })
    : null;

  return (
    <header className="space-y-3">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 rounded-md text-caption font-medium text-text-secondary hover:text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('backTo', { title })}
      </Link>

      <div className="space-y-2">
        <h1 className="text-h3 font-bold tracking-tight text-text-primary sm:text-h2">{title}</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          {summary.movie?.certificate ? (
            <Badge tone="neutral">{summary.movie.certificate}</Badge>
          ) : null}
          {summary.movie?.language ? <Badge tone="info">{summary.movie.language}</Badge> : null}
          {summary.screen?.format ? <Badge tone="neutral">{summary.screen.format}</Badge> : null}
          {runtime ? <Badge tone="neutral">{runtime}</Badge> : null}
          {summary.event.refundsEnabled ? null : (
            <Badge tone="warning">{t('nonCancellable')}</Badge>
          )}
        </div>
        <p className="text-[0.9375rem] text-text-secondary">
          {place}
          <span aria-hidden> · </span>
          <time dateTime={summary.startsAt} className="font-medium text-text-primary">
            {day(summary.startsAt, summary.timeZone, intlLocale)},{' '}
            {clock(summary.startsAt, summary.timeZone, intlLocale)}
            {zone}
          </time>
        </p>
      </div>

      {summary.status === 'CANCELLED' || summary.status === 'PAUSED' ? (
        <p
          role="status"
          className={`flex items-start gap-2 rounded-md px-3 py-2 text-[0.9375rem] ${
            summary.status === 'CANCELLED'
              ? 'bg-tint-error text-status-error'
              : 'bg-tint-warning text-status-warning'
          }`}
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {summary.status === 'CANCELLED' ? t('showCancelled') : t('showPaused')}
        </p>
      ) : null}

      {summary.movie && summary.cinema ? (
        <ShowtimeSwitcher summary={summary} locale={intlLocale} />
      ) : null}
    </header>
  );
}

const PILL_TONE: Record<PublicShowRow['availability'], string> = {
  AVAILABLE: 'border-status-success',
  LIMITED: 'border-status-warning',
  SOLD_OUT: 'border-border',
  SALES_PAUSED: 'border-border',
};

/**
 * The other times this film plays at this cinema on the same day — switching show without
 * going back to the film page, the way a buyer compares 6 pm with 9:30 pm.
 *
 * Coloured by the same availability the film page uses, and never by colour alone: a filling
 * show says so in words, and a sold-out one is not a link.
 */
function ShowtimeSwitcher({ summary, locale }: { summary: PublicShowSummary; locale?: string }) {
  const t = useTranslations('storefront.seats');
  const start = Date.parse(summary.startsAt);
  const siblings = useQuery({
    queryKey: ['show-siblings', summary.movie?.slug, summary.cinema?.id, summary.localDate],
    // A window around this show wide enough to hold its whole local day in any zone.
    queryFn: () =>
      webKit.publicMovies.shows(summary.movie!.slug, {
        from: new Date(start - 20 * 3_600_000).toISOString(),
        to: new Date(start + 20 * 3_600_000).toISOString(),
        limit: 200,
      }),
    staleTime: 60_000,
  });

  const rows = (siblings.data?.shows ?? [])
    .filter((row) => row.cinema?.id === summary.cinema?.id && row.localDate === summary.localDate)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  // Only worth the space when there is somewhere else to go.
  if (rows.filter((row) => row.sessionId !== summary.sessionId).length === 0) return null;

  return (
    <nav aria-label={t('otherShowtimes')} className="min-w-0">
      <p className="mb-1.5 text-caption font-medium text-text-muted">{t('otherShowtimes')}</p>
      <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {rows.map((row) => {
          const time = clock(row.startsAt, summary.timeZone, locale);
          const detail = row.format ?? row.screen?.name ?? '';
          const state =
            row.availability === 'LIMITED'
              ? t('fillingFast')
              : row.availability === 'SOLD_OUT'
                ? t('soldOut')
                : row.availability === 'SALES_PAUSED'
                  ? t('salesPaused')
                  : null;
          const body = (
            <>
              <span className="text-[0.9375rem] font-semibold tabular-nums">{time}</span>
              {detail ? (
                <span className="text-[0.6875rem] uppercase tracking-wide">{detail}</span>
              ) : null}
              {state ? <span className="text-[0.6875rem] font-medium">{state}</span> : null}
            </>
          );
          const base =
            'flex min-w-[5.5rem] flex-col items-center rounded-md border px-3 py-1.5 text-center';

          if (row.sessionId === summary.sessionId) {
            return (
              <li key={row.sessionId} className="shrink-0">
                <span
                  aria-current="true"
                  aria-label={t('currentShowtime', { time })}
                  className={`${base} border-action-primary bg-action-primary text-action-primary-foreground`}
                >
                  {body}
                </span>
              </li>
            );
          }
          if (row.availability === 'SOLD_OUT' || row.availability === 'SALES_PAUSED') {
            return (
              <li key={row.sessionId} className="shrink-0">
                <span className={`${base} border-border bg-background-subtle text-text-muted`}>
                  {body}
                </span>
              </li>
            );
          }
          return (
            <li key={row.sessionId} className="shrink-0">
              <Link
                href={`/shows/${row.sessionId}`}
                aria-label={t('showtimeOption', {
                  time,
                  detail: [detail, state].filter(Boolean).join(', ') || time,
                })}
                className={`${base} ${PILL_TONE[row.availability]} bg-background-surface text-text-primary hover:bg-tint-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-safe:transition-colors ${
                  row.availability === 'LIMITED' ? '[&>span:last-child]:text-status-warning' : ''
                }`}
              >
                {body}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
