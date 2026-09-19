'use client';

import { Heart, MapPin } from 'lucide-react';
import { useId, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import type { CinemaShowtimes } from '@eticketsgo/web-kit';
import { useFormat } from '@/lib/format';
import { ShowtimePill } from './showtime-pill';
import { focusRing } from './styles';

const noSubscription = () => () => undefined;

/** The reader's own zone on the client; undefined on the server, so hydration agrees. */
function useViewerTimeZone(): string | undefined {
  return useSyncExternalStore(
    noSubscription,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => undefined,
  );
}

/**
 * One cinema's screenings on the chosen day.
 *
 * Times are the cinema's. When that is not the reader's own zone — someone in Toronto planning
 * a trip to Hyderabad — the card says which zone they are in, instead of leaving "6:30 pm" to be
 * read as Toronto time.
 */
export function CinemaCard({
  group,
  onToggleFavourite,
}: {
  group: CinemaShowtimes;
  onToggleFavourite: (key: string) => void;
}) {
  const t = useTranslations('showtimes.cinema');
  const { zoneAbbrev } = useFormat();
  const headingId = useId();
  const viewerZone = useViewerTimeZone();

  // "PVR" beside "PVR Nexus" says nothing twice.
  const brand =
    group.brand && !group.name.toLowerCase().includes(group.brand.toLowerCase())
      ? group.brand
      : null;
  const zone =
    group.timeZone && viewerZone && group.timeZone !== viewerZone
      ? zoneAbbrev(group.shows[0]?.startsAt, group.timeZone)
      : null;

  return (
    <article
      aria-labelledby={headingId}
      className="min-w-0 rounded-lg border border-border bg-background-surface p-4 shadow-sm sm:p-5 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-6"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="text-body font-semibold text-text-primary">
            {group.name}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-text-muted">
            <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{group.city}</span>
            {brand && (
              <>
                <span aria-hidden>-</span>
                <span>{brand}</span>
              </>
            )}
          </p>
          {/*
            Its own line: set inline, the separator before it was left dangling at the end of the
            first line whenever the note wrapped.
          */}
          {zone && (
            <p className="mt-0.5 text-caption text-text-muted">{t('localTime', { zone })}</p>
          )}
        </div>
        <button
          type="button"
          aria-pressed={group.favourite}
          aria-label={t('favourite', { name: group.name })}
          onClick={() => onToggleFavourite(group.key)}
          className={`-mr-1.5 -mt-1.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-background-subtle ${focusRing} ${
            group.favourite ? 'text-status-error' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          {/* Filled when on: the shape changes, not just the colour. */}
          <Heart className={`h-5 w-5 ${group.favourite ? 'fill-current' : ''}`} aria-hidden />
        </button>
      </div>
      <ul className="mt-3 grid min-w-0 grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2 lg:mt-0">
        {group.shows.map((show) => (
          <li key={show.sessionId} className="min-w-0">
            <ShowtimePill show={show} />
          </li>
        ))}
      </ul>
    </article>
  );
}
