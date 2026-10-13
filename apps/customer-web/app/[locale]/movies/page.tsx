'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { Film, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  DISCOVERY_COUNTRIES,
  cityScope,
  countryKey,
  countryLabelOf,
  countryPhrase,
  selectedPlace,
  useCity,
} from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { MovieCard } from '@/components/movie-card';
import { Button, EmptyState, ErrorState, Input, Select } from '@/components/ui';
import { EmptyPlace, PlaceSections } from '@/components/place-sections';

export default function MoviesPage() {
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
   * US just yet" is a database row.
   */
  const place = city ?? (preference.country ? countryPhrase(preference.country) : null);
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
  const buckets = useMemo(() => {
    const shown = new Set((data ?? []).map((m) => m.id));
    const sameCountry = (near.data ?? []).filter((m) => !shown.has(m.id));
    sameCountry.forEach((m) => shown.add(m.id));
    const others = DISCOVERY_COUNTRIES.filter((c) => c !== homeCode);
    const elsewhere = others.flatMap((code, i) => {
      const items = (abroad[i]?.data ?? []).filter((m) => !shown.has(m.id));
      return items.length > 0 ? [{ code, name: countryLabelOf(code), items }] : [];
    });
    return { sameCountry, elsewhere, homeCountry: homeCode };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, near.data, homeCode, ...abroad.map((q) => q.data)]);

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
    <div className="space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">Movies</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">Find a film and book your seats.</p>
      </div>

      <form
        className="grid gap-3 rounded-lg border border-border bg-background-surface p-4 shadow-sm sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ q: q || undefined, genre: genre || undefined });
        }}
      >
        <Input
          id="q"
          label="Search"
          icon={Search}
          placeholder="Title..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select id="genre" label="Genre" value={genre} onChange={(e) => setGenre(e.target.value)}>
          <option value="">All genres</option>
          {genres.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </Select>
        <div className="flex items-end">
          <Button type="submit" className="w-full">
            Search
          </Button>
        </div>
      </form>

      {isError ? (
        <ErrorState
          message="We couldn't load movies. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="aspect-[2/3] animate-pulse rounded-lg border border-border bg-background-subtle"
            />
          ))}
        </div>
      ) : data && data.length > 0 ? (
        <>
          <p className="text-caption text-text-muted">
            {data.length} movie{data.length === 1 ? '' : 's'}
          </p>
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
            {data.map((m) => (
              <MovieCard key={m.id} movie={m} />
            ))}
          </div>
        </>
      ) : /*
          Same reasoning as Browse: an empty page must name its cause.

          The location is the cause nobody guesses, because it was chosen once in the header
          and then forgotten. It names the place, offers cities in the same country that have
          films, and the groups below still show the rest of the country and the world.
        */
      cityOnly && place ? (
        <EmptyPlace place={place} noun="films" icon={Film} />
      ) : (
        <EmptyState title="No movies match your search" hint="Try clearing filters." icon={Film} />
      )}

      {/* Beyond the selected city: the rest of its country, then the world, by country. */}
      {hasPlace && !isLoading && !isError && (
        <div className="space-y-12" data-testid="place-groups">
          <PlaceSections
            buckets={{ ...buckets, sameCountry: placeInfo.city ? buckets.sameCountry : [] }}
            render={(items) => (
              <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
                {items.map((m) => (
                  <MovieCard key={m.id} movie={m} />
                ))}
              </div>
            )}
          />
        </div>
      )}
    </div>
  );
}
