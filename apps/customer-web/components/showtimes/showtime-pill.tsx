'use client';

import { Moon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  isBookable,
  isLateNight,
  showTimeZone,
  showtimeLabel,
  timeOfDay,
  type PublicShowRow,
} from '@eticketsgo/web-kit';
import { useFormat } from '@/lib/format';
import { Link } from '@/i18n/navigation';
import { focusRing } from './styles';

const pillShape =
  'flex h-full min-h-[3.75rem] w-full flex-col items-center justify-center rounded-brand-control border px-2 py-1.5 text-center';

/**
 * One screening.
 *
 * Bookable shows are links to the seat page. Sold-out and paused shows are plain text, not a
 * disabled link: a link that goes nowhere is still announced as a link and still takes a tab
 * stop. The data attributes are for tests, which need to read a pill's state without parsing
 * its words.
 */
export function ShowtimePill({ show }: { show: PublicShowRow }) {
  const t = useTranslations('showtimes');
  const { money, locale } = useFormat();

  const zone = showTimeZone(show);
  const time = showtimeLabel(show.startsAt, { timeZone: zone, locale });
  const lateNight = isLateNight(show.startsAt, zone);
  const screen = show.format ?? show.screen?.name ?? null;
  const status = t(`status.${show.availability}`);
  // Always with the row's currency: `money` quietly assumes rupees otherwise.
  const price =
    show.fromPriceMinor == null
      ? null
      : show.fromPriceMinor === 0
        ? t('pill.free')
        : money(show.fromPriceMinor, show.currency);

  const data = {
    'data-testid': 'showtime',
    'data-session-id': show.sessionId,
    'data-availability': show.availability,
    'data-format': show.format ?? '',
    'data-time-of-day': timeOfDay(show.startsAt, zone),
  };

  if (!isBookable(show.availability)) {
    return (
      <div
        {...data}
        className={`${pillShape} border-dashed border-brand-line-strong bg-brand-sunken text-brand-ink-3`}
      >
        <span className="inline-flex items-center gap-1 text-brand-body font-medium leading-tight tabular-nums">
          {time}
          {lateNight && <Moon className="h-3.5 w-3.5" aria-hidden />}
        </span>
        <span className="text-brand-meta">{status}</span>
        {(screen || lateNight) && (
          <span className="sr-only">
            {[screen, lateNight ? t('pill.lateNight') : null]
              .filter(Boolean)
              .map((part) => `, ${part}`)
              .join('')}
          </span>
        )}
      </div>
    );
  }

  const limited = show.availability === 'LIMITED';
  const name = [
    time,
    screen,
    status,
    lateNight ? t('pill.lateNight') : null,
    price === null ? null : show.fromPriceMinor === 0 ? price : t('pill.from', { price }),
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Link
      {...data}
      href={`/shows/${show.sessionId}`}
      aria-label={name}
      className={`${pillShape} bg-brand-surface motion-safe:transition-colors motion-safe:duration-150 ${focusRing} ${
        limited
          ? 'border-brand-caution hover:bg-brand-caution-tint'
          : 'border-brand-positive hover:bg-brand-positive-tint'
      }`}
    >
      <span
        className={`inline-flex items-center gap-1 text-brand-body font-semibold leading-tight tabular-nums ${
          limited ? 'text-brand-caution' : 'text-brand-positive'
        }`}
      >
        {time}
        {lateNight && <Moon className="h-3.5 w-3.5" aria-hidden />}
      </span>
      {(screen || price) && (
        <span className="mt-0.5 flex max-w-full items-center justify-center gap-1 text-brand-meta tabular-nums text-brand-ink-2">
          {screen && <span className="truncate">{screen}</span>}
          {screen && price && <span aria-hidden>-</span>}
          {price && <span className="shrink-0">{price}</span>}
        </span>
      )}
      {limited && (
        <span className="mt-0.5 inline-flex items-center gap-1 text-brand-meta font-semibold text-brand-caution">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand-caution" />
          {status}
        </span>
      )}
    </Link>
  );
}
