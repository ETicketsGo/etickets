'use client';

import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import {
  parseSearchQuery,
  emptyResultSuggestions,
  type SearchIntent,
} from '@eticketsgo/shared-types';
import { api } from '@/lib/api';
import { EventCard } from '@/components/event-card';
import { Button, EmptyState, ErrorState, Input } from '@/components/ui';

const PAGE_SIZE = 24;

export default function EventsPage() {
  const [q, setQ] = useState('');
  const [city, setCity] = useState('');
  const [category, setCategory] = useState('');
  const [applied, setApplied] = useState<{ q?: string; city?: string; category?: string }>({});
  const [page, setPage] = useState(1);
  // Accumulate loaded pages so "Load more" appends rather than replaces.
  const [items, setItems] = useState<ComponentProps<typeof EventCard>['event'][]>([]);
  // Smart-search (WS6): deterministic interpretation of the free-text query.
  const [intent, setIntent] = useState<SearchIntent | null>(null);

  const catQ = useQuery({ queryKey: ['public-categories'], queryFn: () => api.publicCategories() });
  const categoryNames = useMemo(() => (catQ.data ?? []).map((c) => c.category), [catQ.data]);
  const cities = useMemo(
    () => Array.from(new Set(items.map((i) => i.venue?.city).filter(Boolean) as string[])),
    [items],
  );

  // Honour deep links from the home page (?q= / ?category= / ?city=).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const initial = {
      q: p.get('q') ?? '',
      city: p.get('city') ?? '',
      category: p.get('category') ?? '',
    };
    setQ(initial.q);
    setCity(initial.city);
    setCategory(initial.category);
    setApplied({
      q: initial.q || undefined,
      city: initial.city || undefined,
      category: initial.category || undefined,
    });
  }, []);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['events', applied, page],
    queryFn: () => api.listEvents({ pageSize: String(PAGE_SIZE), page: String(page), ...applied }),
  });

  // Replace on a new search (page 1), append on Load more.
  useEffect(() => {
    if (!data) return;
    setItems((prev) => (page === 1 ? data.data : [...prev, ...data.data]));
  }, [data, page]);

  const applyFilters = () => {
    setPage(1);
    // Deterministic parse of the free-text query: pull out category/city, keep the
    // rest as the title search. Explicit fields still win over interpretation.
    const parsed = parseSearchQuery(q, { categories: categoryNames, cities, now: new Date() });
    setIntent(parsed);
    setApplied({
      q: parsed.text || undefined,
      city: city || parsed.city || undefined,
      category: category || parsed.category || undefined,
    });
  };
  const hasFilters = Boolean(applied.q || applied.city || applied.category);
  const clearFilters = () => {
    setQ('');
    setCity('');
    setCategory('');
    setPage(1);
    setApplied({});
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">Browse events</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Search by title, city, or category.
        </p>
      </div>

      <form
        className="grid gap-3 rounded-lg border border-border bg-background-surface p-4 shadow-sm sm:grid-cols-[1fr_1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters();
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
        <Input
          id="city"
          label="City"
          placeholder="Bengaluru"
          value={city}
          onChange={(e) => setCity(e.target.value)}
        />
        <Input
          id="category"
          label="Category"
          placeholder="Music"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <div className="flex items-end">
          <Button type="submit" className="w-full">
            Search
          </Button>
        </div>
      </form>

      {intent && intent.applied.length > 0 && (
        <p className="text-caption text-text-muted" role="status">
          Interpreted your search as:{' '}
          {intent.applied.map((a, i) => (
            <span
              key={a}
              className="mr-1 inline-block rounded-full bg-background-subtle px-2 py-0.5 text-text-secondary"
            >
              {a}
              {i < intent.applied.length - 1 ? '' : ''}
            </span>
          ))}
        </p>
      )}

      {isError ? (
        <ErrorState
          message="We couldn't load events. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-72 animate-pulse rounded-lg border border-border bg-background-subtle"
            />
          ))}
        </div>
      ) : items.length > 0 ? (
        <>
          <p className="text-caption text-text-muted">
            Showing {items.length} of {data?.meta.total ?? items.length} event(s)
          </p>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </div>
          {data && items.length < data.meta.total && (
            <div className="flex justify-center pt-2">
              <Button
                variant="secondary"
                disabled={isFetching}
                onClick={() => setPage((p) => p + 1)}
              >
                {isFetching ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      ) : (
        <EmptyState
          title="No events match your search"
          hint={
            hasFilters
              ? intent
                ? emptyResultSuggestions(intent, categoryNames).slice(0, 3).join(' · ')
                : 'Try clearing your filters.'
              : 'Check back soon for new events.'
          }
          icon={Search}
          action={
            hasFilters ? (
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
