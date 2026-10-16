'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  api,
  applyShowtimeFilters,
  BRAND_FOCUS,
  BrandButton,
  brandButtonClasses,
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
import { Link } from '@/i18n/navigation';
import { BRAND_WRAP, BrandEmpty, BrandPage } from '@/components/storefront-brand';
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
  const tx = useTranslations('common');
  const { slug } = useParams<{ slug: string }>();

  // The header's location, as Movies applies it: a chosen city, else the visitor's country. Sending
  // the city alone let a "United States" visitor see a Hyderabad screening priced in rupees.
  const preference = useCity();
  const scope = cityScope(preference);
  const city = scope.city ?? null;
  const country = scope.country ?? null;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['movie-shows', slug, city, country],
    queryFn: () =>
      api.publicMovies.shows(slug, {
        city: city ?? undefined,
        country: country ?? undefined,
        limit: SHOW_LIMIT,
      }),
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

  if (isLoading)
    return (
      <BrandPage>
        <ShowtimesSkeleton />
      </BrandPage>
    );

  if (isError || !data) {
    const notFound = error instanceof ApiRequestError && error.code === 'NOT_FOUND';
    return (
      <BrandPage>
        <div className={`${BRAND_WRAP} pt-10`}>
          {notFound || !isError ? (
            <BrandEmpty
              headingLevel="h2"
              title={t('movie.notFoundTitle')}
              hint={t('movie.notFoundHint')}
              action={
                <Link href="/movies" className={brandButtonClasses('secondary', 'md')}>
                  {t('movie.browseMovies')}
                </Link>
              }
            />
          ) : (
            <BrandEmpty
              headingLevel="h2"
              title={t('movie.loadError')}
              action={
                <BrandButton variant="secondary" onClick={() => void refetch()}>
                  {tx('action.retry')}
                </BrandButton>
              }
            />
          )}
        </div>
      </BrandPage>
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
    <BrandPage>
      <MovieHero movie={data.movie} />

      <div className={`${BRAND_WRAP} min-w-0 space-y-12 pt-8 sm:pt-10 lg:space-y-16`}>
        <section aria-labelledby="showtimes-heading" className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <h2 id="showtimes-heading" className="font-brand-display text-brand-d2 text-brand-ink">
              {t('heading')}
            </h2>
            {rows.length > 0 && <AvailabilityLegend />}
          </div>

          {rows.length === 0 ? (
            city ? (
              /*
                Same reasoning as Movies: an empty page must name its cause, and the location
                is the cause nobody guesses - it was chosen once in the header and forgotten.
              */
              <BrandEmpty
                title={t('empty.noShowsInCityTitle', { city })}
                hint={t('empty.noShowsInCityHint')}
                action={
                  <BrandButton variant="secondary" onClick={() => preference.setCity(null)}>
                    {t('city.showAll')}
                  </BrandButton>
                }
              />
            ) : (
              <BrandEmpty title={t('empty.noShowsTitle')} hint={t('empty.noShowsHint')} />
            )
          ) : (
            <>
              {/*
                The choices that narrow the list, on one sunken bar: the day, then the format and
                the time of day. Sunken rather than a white card with a shadow, so the cinemas
                below are the only surfaces on the page.
              */}
              <div className="space-y-2 rounded-brand-card bg-brand-sunken p-2 sm:p-3">
                <DateStrip
                  days={view.strip}
                  selected={view.selected}
                  onSelect={selectDay}
                  paging={paging}
                />
                <div className="border-t border-brand-line pt-2">
                  <ShowtimeFilterBar
                    formats={formats}
                    filters={view.active}
                    timeCounts={view.timeCounts}
                    onChange={setFilters}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-brand-meta text-brand-ink-3">
                <p role="status">
                  {t('summary', { shows: view.visible.length, cinemas: view.cinemas.length })}
                </p>
                {city && (
                  <p className="flex flex-wrap items-center gap-x-2">
                    <span>{t('city.scoped', { city })}</span>
                    <button
                      type="button"
                      onClick={() => preference.setCity(null)}
                      className={`inline-flex min-h-11 items-center rounded-sm font-semibold text-brand-ink underline decoration-brand-line-strong underline-offset-4 hover:decoration-brand-ink sm:min-h-0 ${BRAND_FOCUS}`}
                    >
                      {t('city.showAll')}
                    </button>
                  </p>
                )}
              </div>

              {view.cinemas.length === 0 ? (
                <BrandEmpty
                  title={t('empty.noMatchTitle')}
                  hint={t('empty.noMatchHint')}
                  action={
                    hasActiveShowtimeFilters(view.active) ? (
                      <BrandButton
                        variant="secondary"
                        onClick={() => setFilters(NO_SHOWTIME_FILTERS)}
                      >
                        {t('filters.clear')}
                      </BrandButton>
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
                <p className="text-brand-meta text-brand-ink-3">
                  {t('truncated', { returned: data.meta.returned, total: data.meta.total })}
                </p>
              )}
            </>
          )}
        </section>

        <MovieRatings slug={data.movie.slug} />
      </div>
    </BrandPage>
  );
}
