'use client';

import { useQuery } from '@tanstack/react-query';
import { Film, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { MovieCard } from '@/components/movie-card';
import { Button, EmptyState, ErrorState, Input, Select } from '@/components/ui';

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

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['movies', applied],
    queryFn: () => api.listMovies(applied),
  });

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
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Find a film and book your seats.
        </p>
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
          placeholder="Title…"
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
          <p className="text-caption text-text-muted">{data.length} movie(s)</p>
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
            {data.map((m) => (
              <MovieCard key={m.id} movie={m} />
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          title="No movies match your search"
          hint="Try clearing filters."
          icon={Film}
        />
      )}
    </div>
  );
}
