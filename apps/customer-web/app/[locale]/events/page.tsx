'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarDays, MapPin, Search, Tag, Ticket, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  parseSearchQuery,
  emptyResultSuggestions,
  type SearchIntent,
} from '@eticketsgo/shared-types';
import { cityScope, useCity, type SellableCity } from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { EventCard } from '@/components/event-card';
import { Button, EmptyState, ErrorState, Input, Select } from '@/components/ui';
import { useTranslations } from 'next-intl';

const PAGE_SIZE = 24;

/**
 * What Browse is currently asking the API for.
 *
 * Kept as one object rather than as loose state because it IS the query — everything the
 * customer can see about their own search has to be derivable from this, and every field
 * in it has to actually be sent. The previous version parsed dates and a free-only flag
 * out of the query, told the customer it had applied them, and then sent only three of
 * them. That is the failure this shape exists to make impossible: if it is in here it is
 * in the request, and if it is not in here it is not claimed in the UI.
 */
interface AppliedFilters {
  q?: string;
  city?: string;
  category?: string;
  dateFrom?: string;
  dateTo?: string;
  freeOnly?: boolean;
}

/** Date windows worth one click. Anything more specific belongs in the query text. */
type DateWindow = 'any' | 'today' | 'weekend' | 'month';

function dateWindowRange(window: DateWindow): { dateFrom?: string; dateTo?: string } {
  if (window === 'any') return {};
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (window === 'today') {
    end.setHours(23, 59, 59, 0);
  } else if (window === 'weekend') {
    // The coming Saturday through Sunday night — "this weekend" means the next one, even
    // when it is Tuesday.
    const toSat = (6 - now.getDay() + 7) % 7;
    start.setDate(now.getDate() + toSat);
    start.setHours(0, 0, 0, 0);
    end.setTime(start.getTime());
    end.setDate(start.getDate() + 1);
    end.setHours(23, 59, 59, 0);
  } else {
    end.setDate(now.getDate() + 30);
    end.setHours(23, 59, 59, 0);
  }
  // A window that has already started never reaches into the past — the API refuses that
  // anyway, and sending it would make the request disagree with the chip.
  return {
    dateFrom: start > now ? start.toISOString() : now.toISOString(),
    dateTo: end.toISOString(),
  };
}

const DATE_WINDOWS: { value: DateWindow; label: string }[] = [
  { value: 'any', label: 'Any date' },
  { value: 'today', label: 'Today' },
  { value: 'weekend', label: 'This weekend' },
  { value: 'month', label: 'Next 30 days' },
];

/** A parsed yyyy-mm-dd covers the whole day, not the instant it starts. */
const isoStart = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const isoEnd = (day: string) => new Date(`${day}T23:59:59`).toISOString();

/** One thing the customer has narrowed by, and how to stop narrowing by it. */
function FilterChip({
  icon: Icon,
  label,
  onRemove,
}: {
  icon: typeof MapPin;
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background-surface py-1 pl-2.5 pr-1 text-caption text-text-secondary">
      <Icon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${label}`}
        className="rounded-full p-0.5 text-text-muted transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

export default function EventsPage() {
  const n = useTranslations('common.nav');
  const [q, setQ] = useState('');
  const [city, setCity] = useState('');
  const [category, setCategory] = useState('');
  const [dateWindow, setDateWindow] = useState<DateWindow>('any');
  const [applied, setApplied] = useState<AppliedFilters>({});
  const [page, setPage] = useState(1);
  // Accumulate loaded pages so "Load more" appends rather than replaces.
  const [items, setItems] = useState<ComponentProps<typeof EventCard>['event'][]>([]);
  // Smart-search (WS6): deterministic interpretation of the free-text query.
  const [intent, setIntent] = useState<SearchIntent | null>(null);

  const catQ = useQuery({ queryKey: ['public-categories'], queryFn: () => api.publicCategories() });
  const categoryNames = useMemo(() => (catQ.data ?? []).map((c) => c.category), [catQ.data]);

  /*
    Where this page starts.

    Three things can name a place and they are ranked, not merged: a link that says ?city=
    is the most specific intent there is, then the city chip in the header, then the
    country we think they are in. Preferring the URL matters because a shared link to
    "events in Pune" has to open in Pune for somebody whose header says Mumbai.
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
    // A URL city is an explicit intent and settles it; otherwise the header, once it
    // arrives, gets one chance to seed the page.
    if (initial.city) seeded.current = true;
  }, []);

  /*
    The header, in its two different moods.

    A GUESS arrives asynchronously and gets exactly one chance to seed the page, so it can
    never come back later and overwrite something the customer has typed since.

    A CHOICE — someone using the picker in the header — wins every time it happens, not
    just the first time. Collapsing the two is a bug I wrote and the QA suite caught: the
    country hint resolves within a second of load, burned the single seed, and from then on
    picking Bengaluru in the header changed the chip and left Browse showing Mumbai. The
    same class of disagreement this change exists to remove, reintroduced two files away.

    A country, unlike a city, never appears in the City box — it is not something they
    typed, and putting it there would make "India" look like a city name.
  */
  const headerScope = cityScope(preference);
  const headerScopeKey = JSON.stringify(headerScope);
  useEffect(() => {
    if (preference.chosen) {
      seeded.current = true;
      setPage(1);
      setCity(preference.city ?? '');
      setApplied((prev) => ({ ...prev, city: preference.city ?? undefined }));
      return;
    }
    if (seeded.current || (!headerScope.city && !headerScope.country)) return;
    seeded.current = true;
    if (headerScope.city) setCity(headerScope.city);
    setApplied((prev) => ({ ...prev, city: headerScope.city }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerScopeKey, preference.chosen, preference.city]);

  /*
    The country scope is applied to the REQUEST but is never part of `applied`.

    `applied` is what the customer chose, and it drives the chips and the empty-state copy.
    The country is what we inferred on their behalf; folding it in would put a chip saying
    "India" on a page where nobody asked for India. It still has to reach the API, or the
    homepage and Browse would disagree about which events exist.
  */
  const request = useMemo(() => {
    const { freeOnly, ...rest } = applied;
    return {
      ...rest,
      ...(freeOnly ? { freeOnly: 'true' } : {}),
      ...(applied.city ? {} : preference.country ? { country: preference.country } : {}),
    };
  }, [applied, preference.country]);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['events', request, page],
    queryFn: () => api.listEvents({ pageSize: String(PAGE_SIZE), page: String(page), ...request }),
  });

  // Replace on a new search (page 1), append on Load more.
  useEffect(() => {
    if (!data) return;
    setItems((prev) => (page === 1 ? data.data : [...prev, ...data.data]));
  }, [data, page]);

  /**
   * The city the customer typed, resolved against cities we can actually sell in.
   *
   * `city=` is an exact match at the API, so a typed "mumb" or "bombay" would return an
   * empty page for a city with thirteen events in it. Resolving a prefix to the real name
   * fixes the near-misses; anything that resolves to nothing is deliberately NOT sent as a
   * city — it goes into the free-text query instead, where it still matches a venue name
   * or city, because finding something is better than a confident zero.
   */
  const resolveCity = useCallback(
    async (typed: string): Promise<{ city?: string; asText?: string }> => {
      const term = typed.trim();
      if (!term) return {};
      const found: SellableCity[] = await preference.searchCities(term);
      const exact = found.find((c) => c.city.toLowerCase() === term.toLowerCase());
      if (exact) return { city: exact.city };
      if (found.length === 1) return { city: found[0].city };
      return { asText: term };
    },
    [preference],
  );

  const applyFilters = async () => {
    setPage(1);
    // Deterministic parse of the free-text query: pull out category, city, date and the
    // free-only flag, keep the rest as the title search. Explicit fields still win.
    const parsed = parseSearchQuery(q, {
      categories: categoryNames,
      cities: preference.topCities.map((c) => c.city),
      now: new Date(),
    });
    setIntent(parsed);

    const typed = city || parsed.city || '';
    const resolved = await resolveCity(typed);
    const window = dateWindowRange(dateWindow);

    const next: AppliedFilters = {
      // A city we could not place is still worth searching for as text.
      q: [parsed.text, resolved.asText].filter(Boolean).join(' ').trim() || undefined,
      city: resolved.city,
      category: category || parsed.category || undefined,
      // The picker wins over the query text: it is the more recent, more deliberate act.
      ...(dateWindow !== 'any'
        ? window
        : parsed.dateFrom
          ? {
              dateFrom: isoStart(parsed.dateFrom),
              dateTo: isoEnd(parsed.dateTo ?? parsed.dateFrom),
            }
          : {}),
      freeOnly: parsed.freeOnly || undefined,
    };
    setApplied(next);
    if (resolved.city) setCity(resolved.city);

    /*
      Write through to the header, so the app has ONE answer to "where am I". Without this,
      filtering to Delhi here and returning to the homepage would silently show Mumbai.

      `clearCity` and not `setCity(null)` for the empty case: searching for a title with the
      City box empty means "no city", not "the entire world". Passing null would also drop
      the country scope, so typing "comedy" would quietly widen the page to every country we
      sell in — the exact behaviour this change exists to remove.
    */
    seeded.current = true;
    if (resolved.city) {
      if (resolved.city !== preference.city) preference.setCity(resolved.city);
    } else if (preference.city) {
      preference.clearCity();
    }
  };

  const hasFilters = Boolean(
    applied.q || applied.city || applied.category || applied.dateFrom || applied.freeOnly,
  );
  /**
   * Empty, and the ONLY thing narrowing it is the place.
   *
   * Distinguished from "empty with a search term in the box", where the customer already
   * knows what they typed and a location message would be a red herring.
   */
  const placeOnly =
    !applied.q && !applied.category && !applied.dateFrom && !applied.freeOnly
      ? (applied.city ?? preference.country ?? null)
      : null;

  const clearFilters = () => {
    setQ('');
    setCity('');
    setCategory('');
    setDateWindow('any');
    setPage(1);
    setApplied({});
    setIntent(null);
  };

  /** Drop one filter and re-run, leaving the others exactly as they were. */
  const removeFilter = (key: keyof AppliedFilters) => {
    setPage(1);
    setApplied((prev) => {
      const next = { ...prev };
      delete next[key];
      if (key === 'dateFrom') delete next.dateTo;
      return next;
    });
    if (key === 'q') setQ('');
    if (key === 'city') {
      setCity('');
      // Taking the city chip off leaves the country scope in place: the customer removed
      // one filter, not every filter.
      preference.clearCity();
    }
    if (key === 'category') setCategory('');
    if (key === 'dateFrom') setDateWindow('any');
  };

  const dateLabel = DATE_WINDOWS.find((w) => w.value === dateWindow)?.label ?? 'Dates';

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-h2 font-bold tracking-tight text-text-primary">{n('browseEvents')}</h1>
        <p className="mt-1.5 text-[0.9375rem] text-text-muted">
          Search by title, city, category or date.
        </p>
      </div>

      <form
        className="grid gap-3 rounded-lg border border-border bg-background-surface p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          void applyFilters();
        }}
      >
        <Input
          id="q"
          label="Search"
          icon={Search}
          placeholder="Artist, event or venue…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <CityField value={city} onChange={setCity} search={preference.searchCities} />
        {/*
          A list, not a text box.

          City and category were both free-text inputs matched with `equals` at the API, so
          a customer typing "music" got twelve events and one typing "Musics", "concert" or
          "Live Music" got a confident empty page with nothing to explain it. The category
          set is small, known, and comes with counts — there is no reason to make anyone
          guess at it.
        */}
        <Select
          id="category"
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Any category</option>
          {(catQ.data ?? []).map((c) => (
            <option key={c.category} value={c.category}>
              {c.category} ({c.count})
            </option>
          ))}
        </Select>
        <Select
          id="dates"
          label="When"
          value={dateWindow}
          onChange={(e) => setDateWindow(e.target.value as DateWindow)}
        >
          {DATE_WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>
        <div className="flex items-end">
          <Button type="submit" className="w-full">
            Search
          </Button>
        </div>
      </form>

      {/*
        What is actually narrowing the results, and how to undo each part.

        This replaces an "Interpreted your search as:" line that was read-only — and, worse,
        listed things the request did not contain. Every chip here corresponds to a
        parameter that was sent, and removing one re-runs the search without it.
      */}
      {hasFilters && (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <span className="text-caption text-text-muted">Filtered by</span>
          {applied.q && (
            <FilterChip icon={Search} label={`“${applied.q}”`} onRemove={() => removeFilter('q')} />
          )}
          {applied.city && (
            <FilterChip icon={MapPin} label={applied.city} onRemove={() => removeFilter('city')} />
          )}
          {applied.category && (
            <FilterChip
              icon={Tag}
              label={applied.category}
              onRemove={() => removeFilter('category')}
            />
          )}
          {applied.dateFrom && (
            <FilterChip
              icon={CalendarDays}
              label={dateWindow === 'any' ? 'Selected dates' : dateLabel}
              onRemove={() => removeFilter('dateFrom')}
            />
          )}
          {applied.freeOnly && (
            <FilterChip icon={Ticket} label="Free only" onRemove={() => removeFilter('freeOnly')} />
          )}
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-md px-2 py-0.5 text-caption text-text-muted underline-offset-2 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Naming the wider scope, since it narrows the results and nobody asked for it. */}
      {!applied.city && preference.country && (
        <p className="text-caption text-text-muted">
          Showing events in {preference.country}.{' '}
          <button
            type="button"
            onClick={() => preference.setCity(null)}
            className="font-medium text-action-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Show everywhere
          </button>
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
          An empty page has to name its cause, and the place is the cause the customer is
          least likely to guess.

          The location lives in the header and is set once — or inferred and never
          announced — so by the time somebody opens Browse a fortnight later they have
          forgotten it is there. "No events match your search" then reads as "this platform
          has nothing", when the truth is "nothing in Bengaluru": a real state on this
          platform today, where the events are in Mumbai and the films are in Bengaluru.
        */
        <EmptyState
          title={placeOnly ? `Nothing on in ${placeOnly} just yet` : 'No events match your search'}
          hint={
            placeOnly
              ? 'Other places have events on sale.'
              : hasFilters
                ? intent
                  ? emptyResultSuggestions(intent, categoryNames).slice(0, 3).join(' · ')
                  : 'Try removing a filter above.'
                : 'Check back soon for new events.'
          }
          icon={Search}
          action={
            placeOnly ? (
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

/**
 * A city box that suggests real cities as you type.
 *
 * Backed by the server search rather than by whatever cities happen to be in the current
 * results — which is what the old suggestion list did, so it was empty on first load and
 * could only ever offer cities already on screen. A `datalist` keeps it a plain text field:
 * the customer can still type a city we have not heard of, and `resolveCity` decides what
 * to do with that rather than the input refusing it.
 */
function CityField({
  value,
  onChange,
  search,
}: {
  value: string;
  onChange: (v: string) => void;
  search: (q: string) => Promise<SellableCity[]>;
}) {
  const [options, setOptions] = useState<SellableCity[]>([]);

  useEffect(() => {
    const term = value.trim();
    if (!term) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void search(term).then((found) => {
        if (!cancelled) setOptions(found);
      });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, search]);

  return (
    <div>
      <Input
        id="city"
        label="City"
        icon={MapPin}
        list="city-options"
        // Neutral placeholder: a city name here reads as "this is where the product
        // operates", which misleads visitors outside that market.
        placeholder="Any city"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id="city-options">
        {options.map((c) => (
          <option key={`${c.country}-${c.city}`} value={c.city}>
            {c.country} · {c.eventCount} event{c.eventCount === 1 ? '' : 's'}
          </option>
        ))}
      </datalist>
    </div>
  );
}
