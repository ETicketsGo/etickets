'use client';

import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  parseSearchQuery,
  emptyResultSuggestions,
  type SearchIntent,
} from '@eticketsgo/shared-types';
import { useCity } from '@eticketsgo/web-kit';
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

  /*
    Where this page starts.

    Three things can name a city and they are ranked, not merged: a link that says
    ?city= is the most specific intent there is, then the city chip in the header, then
    nothing. Preferring the URL matters because a shared link to "events in Pune" has to
    open in Pune for somebody whose header says Mumbai.
  */
  const preference = useCity();
  // Set once the page has decided its starting city, so the async header city cannot come
  // back later and overwrite whatever the customer has typed since.
  const seeded = useRef(false);
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
    // A URL city is an explicit intent and settles it; otherwise the header city, once it
    // arrives, gets one chance to seed the page.
    if (initial.city) seeded.current = true;
  }, []);

  // The header city resolves asynchronously, so it is usually not known when the effect
  // above runs. This applies it exactly once, and never after the customer has searched.
  useEffect(() => {
    if (seeded.current || !preference.city) return;
    seeded.current = true;
    setCity(preference.city);
    setApplied((prev) => ({ ...prev, city: preference.city ?? undefined }));
  }, [preference.city]);

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
    const nextCity = city || parsed.city || undefined;
    setApplied({
      q: parsed.text || undefined,
      city: nextCity,
      category: category || parsed.category || undefined,
    });
    // Write through to the header, so the app has ONE answer to "which city am I in".
    // Without this, filtering to Delhi here and returning to the homepage would silently
    // show Mumbai again.
    seeded.current = true;
    if ((nextCity ?? null) !== preference.city) preference.setCity(nextCity ?? null);
  };
  const hasFilters = Boolean(applied.q || applied.city || applied.category);
  /**
   * Empty, and the ONLY thing narrowing it is the city.
   *
   * Distinguished from "empty with a search term in the box", where the customer already
   * knows what they typed and a city message would be a red herring.
   */
  const appliedCityOnly = Boolean(applied.city) && !applied.q && !applied.category;
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
          // Neutral placeholder: a city name here reads as "this is where the product
          // operates", which misleads visitors outside that market.
          placeholder="Any city"
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
        /*
          An empty page has to name its cause, and the city is the cause the customer is
          least likely to guess.

          The city chip lives in the header and is set once, so by the time somebody opens
          Browse a fortnight later they have forgotten it is there. "No events match your
          search" then reads as "this platform has nothing", when the truth is "nothing in
          Bengaluru" — a real state on this platform today, where the events are in Mumbai
          and the films are in Bengaluru. The way out is one click, and it is offered here
          rather than left to be found back in the header.
        */
        <EmptyState
          title={
            appliedCityOnly
              ? `Nothing on in ${applied.city} just yet`
              : 'No events match your search'
          }
          hint={
            appliedCityOnly
              ? 'Other cities have events on sale.'
              : hasFilters
                ? intent
                  ? emptyResultSuggestions(intent, categoryNames).slice(0, 3).join(' · ')
                  : 'Try clearing your filters.'
                : 'Check back soon for new events.'
          }
          icon={Search}
          action={
            appliedCityOnly ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setCity('');
                  setApplied((prev) => ({ ...prev, city: undefined }));
                  preference.setCity(null);
                }}
              >
                Show all cities
              </Button>
            ) : hasFilters ? (
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
