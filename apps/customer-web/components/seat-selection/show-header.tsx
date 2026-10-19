'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronLeft, Info } from 'lucide-react';
import {
  BRAND_FOCUS,
  BrandStatusPill,
  api as webKit,
  formatFor,
  type PublicShowRow,
  type PublicShowSummary,
} from '@eticketsgo/web-kit';
import { Link } from '@/i18n/navigation';
import { useVenueWhenText } from '@/components/booking-brand';
import { summaryZone } from '@/lib/event-when';

/** A time of day in the show's zone: "6:00 pm" in English, "18 h 00" in French. */
function clock(iso: string, timeZone: string | undefined, locale?: string): string {
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
  const venueWhenText = useVenueWhenText();

  const title = summary.movie?.title ?? summary.event.title;
  const backHref = summary.movie
    ? `/movies/${summary.movie.slug}`
    : `/events/${summary.event.slug}`;
  /*
    The building and the city, written the way Review & pay and the confirmation write them
    ("Indiranagar Picture House, Bengaluru"); the screen is a tag beside the film's facts.
  */
  const place = [summary.cinema?.name ?? summary.venue.name, summary.venue.city]
    .filter(Boolean)
    .join(', ');
  /*
    The venue's time with its zone, always named, in the one format every booking screen uses
    (useVenueWhenText). The zone used to appear only when the reader's own zone differed, which
    is wrong for a link forwarded to somebody abroad: the page cannot know who will read it.

    `summaryZone`, not `summary.timeZone`: the API answered null for a room in a venue that is
    not a cinema, and a null printed the READER's clock with the reader's zone missing - on QA a
    Hyderabad 11:01 pm show read "10:31 am" in a Denver browser.
  */
  const when = venueWhenText(summary.startsAt, summaryZone(summary));
  const runtime = summary.movie
    ? t('runtime', {
        hours: Math.floor(summary.movie.runtimeMinutes / 60),
        minutes: summary.movie.runtimeMinutes % 60,
      })
    : null;

  /*
    A fact about the film or the room, as a quiet outlined tag on the stage band. Not a coloured
    badge: the brand has no category colours (DESIGN-SYSTEM.md section 1).
  */
  const tag =
    'inline-flex h-7 items-center rounded-full border border-brand-line-strong px-3 text-brand-meta font-medium text-brand-ink-2';

  return (
    <header
      data-brand-tone="stage"
      className="space-y-4 bg-brand-canvas px-4 pb-8 pt-4 sm:px-6 lg:px-10 lg:pb-10 lg:pt-6"
    >
      <Link
        href={backHref}
        className={`inline-flex min-h-11 items-center gap-1 rounded-sm text-brand-ui font-medium text-brand-ink-2 hover:text-brand-gold-text ${BRAND_FOCUS}`}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {t('backTo', { title })}
      </Link>

      <div className="space-y-3">
        <h1 className="text-balance font-brand-display text-brand-d1 text-brand-ink">{title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {summary.movie?.certificate ? (
            <span className={tag}>{summary.movie.certificate}</span>
          ) : null}
          {summary.movie?.language ? <span className={tag}>{summary.movie.language}</span> : null}
          {summary.screen?.name ? <span className={tag}>{summary.screen.name}</span> : null}
          {summary.screen?.format ? <span className={tag}>{summary.screen.format}</span> : null}
          {runtime ? <span className={tag}>{runtime}</span> : null}
          {summary.event.refundsEnabled ? null : (
            <BrandStatusPill status="caution">{t('nonCancellable')}</BrandStatusPill>
          )}
        </div>
        <p className="text-brand-body text-brand-ink-2">
          <time dateTime={summary.startsAt} className="font-semibold text-brand-ink">
            {when}
          </time>
          <span aria-hidden> - </span>
          {place}
        </p>
      </div>

      {summary.status === 'CANCELLED' || summary.status === 'PAUSED' ? (
        <p
          role="status"
          className={`flex items-start gap-2 rounded-brand-control px-3 py-2 text-brand-ui ${
            summary.status === 'CANCELLED'
              ? 'bg-brand-critical-tint text-brand-critical'
              : 'bg-brand-caution-tint text-brand-caution'
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
  AVAILABLE: 'border-brand-line-strong',
  LIMITED: 'border-brand-caution',
  SOLD_OUT: 'border-brand-line',
  SALES_PAUSED: 'border-brand-line',
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
      <p className="mb-2 text-brand-eyebrow uppercase text-brand-ink-3">{t('otherShowtimes')}</p>
      <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {rows.map((row) => {
          const time = clock(row.startsAt, row.cinema?.timezone ?? summaryZone(summary), locale);
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
              <span className="text-brand-ui font-semibold tabular-nums">{time}</span>
              {detail ? (
                <span className="text-[0.75rem] uppercase tracking-wide">{detail}</span>
              ) : null}
              {state ? <span className="text-[0.75rem] font-medium">{state}</span> : null}
            </>
          );
          const base =
            'flex min-h-11 min-w-[5.5rem] flex-col items-center justify-center rounded-brand-control border px-3 py-1.5 text-center';

          if (row.sessionId === summary.sessionId) {
            return (
              <li key={row.sessionId} className="shrink-0">
                <span
                  aria-current="true"
                  aria-label={t('currentShowtime', { time })}
                  className={`${base} border-brand-marigold bg-brand-marigold text-brand-on-marigold`}
                >
                  {body}
                </span>
              </li>
            );
          }
          if (row.availability === 'SOLD_OUT' || row.availability === 'SALES_PAUSED') {
            return (
              <li key={row.sessionId} className="shrink-0">
                <span className={`${base} border-brand-line text-brand-ink-3`}>{body}</span>
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
                className={`${base} ${PILL_TONE[row.availability]} text-brand-ink hover:border-brand-ink-3 ${BRAND_FOCUS} focus-visible:ring-offset-brand-canvas motion-safe:transition-colors ${
                  row.availability === 'LIMITED' ? '[&>span:last-child]:text-brand-caution' : ''
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
