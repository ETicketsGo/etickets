'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { ChevronDown, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  BrandButton,
  DISCOVERY_COUNTRIES,
  cityScope,
  countryKey,
  countryLabelOf,
  selectedPlace,
  useCity,
} from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { EmptyPlace, PlaceSections } from '@/components/place-sections';
import { Placeholder, Rail, RailItem } from '@/components/home/parts';
import { BRAND_FIELD } from '@/components/booking-brand';
import { BRAND_WRAP, BrandEmpty, BrandPage, FilmCard } from '@/components/storefront-brand';
import { useCountryWords } from '@/lib/country-words';

/*
  ── MOVIES ON THE BRAND LAYER (docs/design/DESIGN-SYSTEM.md) ─────────────────────────────
  The film list in the same system as the home page's "Now showing": posters in the 2:3 box,
  the title under the picture in the display face, the facts and the audience rating below it.
  It used to be the old system's white boxes with a shadow and a blue search button, and a film
  with no poster was a gradient with a film icon on it. Same search, same genre filter, same
  lists and the same place groups as before; only the drawing changed.
*/

/** The one uniform grid this page has: every film in the visitor's place. */
const FILM_GRID =
  'grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 lg:gap-x-6 xl:grid-cols-5';

const LABEL = 'mb-1.5 block text-brand-ui font-semibold text-brand-ink';

export default function MoviesPage() {
  const t = useTranslations('storefront.movies');
  const action = useTranslations('common.action');
  const words = useCountryWords();
  const [q, setQ] = useState('');
  const [genre, setGenre] = useState('');
  const [applied, setApplied] = useState<{ q?: string; genre?: string }>({});

  // Honour deep links (?q= / ?genre=).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const initial = { q: p.get('q') ?? '', genre: p.get('genre') ?? '' };
    setQ(initial.q);
    setGenre(initial.genre);
    setApplied({ q: initial.q || undefined, genre: initial.genre || undefined });
  }, []);

  // Scoped to the header's location. Genres below stay unfiltered on purpose — a genre
  // list that shrinks with the city makes the filter look broken.
  const preference = useCity();
  const { city } = preference;
  const scope = cityScope(preference);
  /**
   * Empty because of the LOCATION alone — not because of something the customer typed.
   *
   * The country counts here, not just the city, and it is the common case rather than the
   * exotic one: discovery scopes to the country the visitor is in whether or not we sell
   * there, so every visitor outside our launch markets lands on this page empty. That is the
   * intended answer, and the only thing that makes it an honest one instead of a broken one
   * is this block — name the place, and offer the way out of it.
   *
   * Named, not coded: "No films in the United States just yet" is a sentence, "No films in
   * US just yet" is a database row. French puts the place after a colon, where the bare name
   * ("Etats-Unis", from `useCountryWords`) is the correct form.
   */
  const place = city ?? (preference.country ? words(preference.country, true) : null);
  const cityOnly = Boolean(place) && !applied.q && !applied.genre;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['movies', applied, JSON.stringify(scope)],
    queryFn: () => api.listMovies({ ...applied, ...scope }),
  });

  /*
    Films beyond the selected city: the rest of its country, then each other country under its
    own title. A film card carries no venue, so each group is its own country-scoped read (with
    the same search and genre), and a film already shown above is never repeated below.
  */
  const placeInfo = selectedPlace(preference);
  const homeCode = countryKey(placeInfo.country);
  const hasPlace = Boolean(placeInfo.city || homeCode);
  const near = useQuery({
    queryKey: ['movies', 'same-country', applied, homeCode],
    queryFn: () => api.listMovies({ ...applied, country: homeCode ?? undefined }),
    enabled: Boolean(placeInfo.city && homeCode),
  });
  const abroad = useQueries({
    queries: DISCOVERY_COUNTRIES.filter((c) => c !== homeCode).map((code) => ({
      queryKey: ['movies', 'abroad', applied, code],
      queryFn: () => api.listMovies({ ...applied, country: code }),
      enabled: hasPlace,
    })),
  });
  /*
    Computed on every render rather than memoised. The memo listed one dependency per OTHER
    country, and that list is one longer before the visitor's country is known than after it, so
    React reported "the final argument passed to useMemo changed size between renders" on every
    visit (the "1 issue" badge in development). Filtering a few dozen films is cheaper than that.
  */
  const buckets = (() => {
    const shown = new Set((data ?? []).map((m) => m.id));
    const sameCountry = (near.data ?? []).filter((m) => !shown.has(m.id));
    sameCountry.forEach((m) => shown.add(m.id));
    const others = DISCOVERY_COUNTRIES.filter((c) => c !== homeCode);
    const elsewhere = others.flatMap((code, i) => {
      const items = (abroad[i]?.data ?? []).filter((m) => !shown.has(m.id));
      return items.length > 0 ? [{ code, name: countryLabelOf(code), items }] : [];
    });
    return { sameCountry, elsewhere, homeCountry: homeCode };
  })();

  // Genre options for the filter come from an unfiltered baseline fetch so the
  // list stays stable regardless of what is currently applied.
  const baseline = useQuery({
    queryKey: ['movies', 'genres'],
    queryFn: () => api.listMovies({}),
  });
  const genres = useMemo(() => {
    const set = new Set<string>();
    (baseline.data ?? []).forEach((m) => m.genres.forEach((g) => set.add(g)));
    return Array.from(set).sort();
  }, [baseline.data]);

  return (
    <BrandPage>
      <section data-brand-tone="stage" className="bg-brand-canvas">
        <div className={`${BRAND_WRAP} py-10 lg:py-14`}>
          <h1 className="text-balance font-brand-display text-brand-d1 text-brand-ink">
            {t('title')}
          </h1>
          <p className="mt-3 max-w-prose text-brand-lead text-brand-ink-2">{t('lead')}</p>
          <span aria-hidden className="mt-6 block h-1 w-10 rounded-full bg-brand-marigold" />
        </div>
      </section>

      <div className={`${BRAND_WRAP} space-y-8 pt-8 lg:pt-10`}>
        <form
          role="search"
          aria-label={t('searchForm')}
          className="grid gap-3 rounded-brand-card bg-brand-sunken p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ q: q || undefined, genre: genre || undefined });
          }}
        >
          <div className="min-w-0">
            <label htmlFor="q" className={LABEL}>
              {t('searchField')}
            </label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-ink-3"
                aria-hidden
              />
              <input
                id="q"
                type="search"
                placeholder={t('placeholder')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className={`${BRAND_FIELD} w-full pl-9`}
              />
            </div>
          </div>
          <div className="min-w-0">
            <label htmlFor="genre" className={LABEL}>
              {t('genre')}
            </label>
            <div className="relative">
              <select
                id="genre"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                className={`${BRAND_FIELD} w-full appearance-none pr-10`}
              >
                <option value="">{t('allGenres')}</option>
                {genres.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-ink-2"
                aria-hidden
              />
            </div>
          </div>
          <BrandButton type="submit" className="w-full sm:w-auto">
            {t('searchButton')}
          </BrandButton>
        </form>

        {isError ? (
          <BrandEmpty
            title={t('loadError')}
            action={
              <BrandButton variant="secondary" onClick={() => void refetch()}>
                {action('retry')}
              </BrandButton>
            }
          />
        ) : isLoading ? (
          <div className={FILM_GRID} aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <Placeholder key={i} className="aspect-[2/3] w-full" />
            ))}
          </div>
        ) : data && data.length > 0 ? (
          <section aria-label={t('listLabel')} className="space-y-4">
            <p role="status" className="text-brand-meta text-brand-ink-3">
              {t('count', { count: data.length })}
            </p>
            <ul className={FILM_GRID}>
              {data.map((m, i) => (
                <li key={m.id} className="min-w-0">
                  <FilmCard movie={m} priority={i < 2} />
                </li>
              ))}
            </ul>
          </section>
        ) : /*
            Same reasoning as Browse: an empty page must name its cause.

            The location is the cause nobody guesses, because it was chosen once in the header
            and then forgotten. It names the place, offers cities in the same country that have
            films, and the groups below still show the rest of the country and the world.
          */
        cityOnly && place ? (
          <EmptyPlace place={place} noun="films" variant="brand" />
        ) : (
          <BrandEmpty title={t('noMatch')} hint={t('noMatchHint')} />
        )}
      </div>

      {/* Beyond the selected city: the rest of its country, then the world, by country. */}
      {hasPlace && !isLoading && !isError && (
        <div
          className={`${BRAND_WRAP} space-y-12 lg:space-y-16 ${
            buckets.elsewhere.length > 0 || (placeInfo.city && buckets.sameCountry.length > 0)
              ? 'pt-12 lg:pt-16'
              : ''
          }`}
          data-testid="place-groups"
        >
          <PlaceSections
            variant="brand"
            buckets={{ ...buckets, sameCountry: placeInfo.city ? buckets.sameCountry : [] }}
            render={(items) => (
              <Rail cols={5} phone="poster" label={t('listLabel')}>
                {items.map((m) => (
                  <RailItem key={m.id}>
                    <FilmCard movie={m} />
                  </RailItem>
                ))}
              </Rail>
            )}
          />
        </div>
      )}
    </BrandPage>
  );
}
