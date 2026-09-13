'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Clock, Film, MapPin, SearchX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  api,
  applyShowtimeFilters,
  buildDateStrip,
  cityScope,
  countByTimeOfDay,
  dateWindows,
  groupShowtimesByCinema,
  hasActiveShowtimeFilters,
  NO_SHOWTIME_FILTERS,
  preferredDay,
  resolveShowDate,
  rowsOnDate,
  useCity,
  windowFor,
  type ShowtimeFilters,
} from '@eticketsgo/web-kit';
import { ApiRequestError } from '@/lib/api';
import { Button, ButtonLink, EmptyState, ErrorState } from '@/components/ui';
import {
  AvailabilityLegend,
  CinemaCard,
  DateStrip,
  MovieHero,
  ShowtimeFilterBar,
  ShowtimesSkeleton,
  useFavouriteCinemas,
} from '@/components/showtimes';
import { MovieRatings } from '@/components/reviews';

/** The API's ceiling. One request holds every screening the page can show. */
const SHOW_LIMIT = 200;

export default function MovieDetailPage() {
  const t = useTranslations('showtimes');
  const { slug } = useParams<{ slug: string }>();

  // The header's location, as Movies applies it. The showtimes endpoint narrows by city only.
  const preference = useCity();
  const city = cityScope(preference).city ?? null;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['movie-shows', slug, city],
    queryFn: () => api.publicMovies.shows(slug, { city: city ?? undefined, limit: SHOW_LIMIT }),
  });

  const [picked, setPicked] = useState<string | null>(null);
  const [filters, setFilters] = useState<ShowtimeFilters>(NO_SHOWTIME_FILTERS);
  const { sortFirst, toggle: toggleFavourite, settle: settleFavourites } = useFavouriteCinemas();

  const rows = useMemo(() => data?.shows ?? [], [data]);
  const formats = useMemo(
    () => [...(data?.filters.formats ?? [])].sort((a, b) => a.localeCompare(b, 'en')),
    [data],
  );

  const view = useMemo(() => {
    const selected = resolveShowDate(rows, picked);
    const windows = dateWindows(rows);
    const windowStart = selected ? windowFor(rows, selected) : null;
    const windowIndex = windowStart ? windows.indexOf(windowStart) : -1;
    // A format chosen in another city may not exist here; it must not silently empty the list.
    const active: ShowtimeFilters = {
      formats: filters.formats.filter((f) => formats.includes(f)),
      times: filters.times,
    };
    const dayRows = rowsOnDate(rows, selected);
    const visible = applyShowtimeFilters(dayRows, active);
    return {
      selected,
      windows,
      windowIndex,
      strip: buildDateStrip(rows, { start: windowStart ?? undefined }),
      active,
      timeCounts: countByTimeOfDay(applyShowtimeFilters(dayRows, { ...active, times: [] })),
      visible,
      cinemas: groupShowtimesByCinema(visible, { favourites: sortFirst }),
    };
  }, [rows, picked, filters, formats, sortFirst]);

  if (isLoading) return <ShowtimesSkeleton />;

  if (isError || !data) {
    const notFound = error instanceof ApiRequestError && error.code === 'NOT_FOUND';
    return notFound || !isError ? (
      <EmptyState
        title={t('movie.notFoundTitle')}
        hint={t('movie.notFoundHint')}
        icon={Film}
        action={
          <ButtonLink href="/movies" variant="secondary">
            {t('movie.browseMovies')}
          </ButtonLink>
        }
      />
    ) : (
      <ErrorState message={t('movie.loadError')} onRetry={() => refetch()} />
    );
  }

  const selectDay = (date: string | null) => {
    setPicked(date);
    // A new day is a fresh list, so newly hearted cinemas can move to the top now.
    settleFavourites();
  };
  const goToWindow = (index: number) =>
    selectDay(preferredDay(buildDateStrip(rows, { start: view.windows[index] })));
  const paging =
    view.windows.length > 1
      ? {
          earlier: view.windowIndex > 0 ? () => goToWindow(view.windowIndex - 1) : null,
          later:
            view.windowIndex >= 0 && view.windowIndex < view.windows.length - 1
              ? () => goToWindow(view.windowIndex + 1)
              : null,
        }
      : null;

  return (
    <div className="min-w-0 space-y-8 sm:space-y-10">
      <MovieHero movie={data.movie} />

      <section aria-labelledby="showtimes-heading" className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 id="showtimes-heading" className="text-h3 font-semibold text-text-primary">
            {t('heading')}
          </h2>
          {rows.length > 0 && <AvailabilityLegend />}
        </div>

        {rows.length === 0 ? (
          city ? (
            /*
              Same reasoning as Movies: an empty page must name its cause, and the location
              is the cause nobody guesses — it was chosen once in the header and forgotten.
            */
            <EmptyState
              title={t('empty.noShowsInCityTitle', { city })}
              hint={t('empty.noShowsInCityHint')}
              icon={MapPin}
              action={
                <Button variant="secondary" onClick={() => preference.setCity(null)}>
                  {t('city.showAll')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={t('empty.noShowsTitle')}
              hint={t('empty.noShowsHint')}
              icon={Clock}
            />
          )
        ) : (
          <>
            <div className="space-y-2 rounded-lg border border-border bg-background-surface p-2 shadow-sm sm:p-3">
              <DateStrip
                days={view.strip}
                selected={view.selected}
                onSelect={selectDay}
                paging={paging}
              />
              <div className="border-t border-border pt-2">
                <ShowtimeFilterBar
                  formats={formats}
                  filters={view.active}
                  timeCounts={view.timeCounts}
                  onChange={setFilters}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-caption text-text-muted">
              <p role="status">
                {t('summary', { shows: view.visible.length, cinemas: view.cinemas.length })}
              </p>
              {city && (
                <p className="flex flex-wrap items-center gap-x-2">
                  <span>{t('city.scoped', { city })}</span>
                  <button
                    type="button"
                    onClick={() => preference.setCity(null)}
                    className="rounded-sm font-semibold text-text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t('city.showAll')}
                  </button>
                </p>
              )}
            </div>

            {view.cinemas.length === 0 ? (
              <EmptyState
                title={t('empty.noMatchTitle')}
                hint={t('empty.noMatchHint')}
                icon={SearchX}
                action={
                  hasActiveShowtimeFilters(view.active) ? (
                    <Button variant="secondary" onClick={() => setFilters(NO_SHOWTIME_FILTERS)}>
                      {t('filters.clear')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <ul aria-label={t('cinema.list')} className="space-y-3">
                {view.cinemas.map((group) => (
                  <li key={group.key} className="min-w-0">
                    <CinemaCard group={group} onToggleFavourite={toggleFavourite} />
                  </li>
                ))}
              </ul>
            )}

            {data.meta.total > data.meta.returned && (
              <p className="text-caption text-text-muted">
                {t('truncated', { returned: data.meta.returned, total: data.meta.total })}
              </p>
            )}
          </>
        )}
      </section>

      <MovieRatings slug={data.movie.slug} />
    </div>
  );
}
