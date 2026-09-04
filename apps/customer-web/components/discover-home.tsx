'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@/i18n/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Clock3, Search, Sparkles, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { EventCard } from '@/components/event-card';
import { getRecent, type RecentEvent } from '@/lib/recent';
import { cityScope, inCityScope, useCity } from '@eticketsgo/web-kit';
import { Button, ButtonLink, EmptyState } from '@/components/ui';

/**
 * The categories to offer, from the categories that exist.
 *
 * This was a hardcoded ['Music', 'Tech', 'Comedy', 'Sports', 'Theatre']. On QA that meant
 * three of the five chips led to a guaranteed empty page — there is no Tech, Sports or
 * Theatre event on the platform — while Community, which has two, was not offered at all.
 * A chip that cannot return a result is worse than no chip: the customer reads the empty
 * page as "nothing on", not as "we suggested something we do not have".
 *
 * `/public/categories` already returns exactly this with counts, and Browse already used
 * it. The homepage simply was not asking.
 */
const MAX_CATEGORY_CHIPS = 6;

function Skeletons({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-72 animate-pulse rounded-lg border border-border bg-background-subtle"
        />
      ))}
    </div>
  );
}

function Section({
  title,
  subtitle,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: typeof Sparkles;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-h3 font-bold tracking-tight text-text-primary">
            {Icon && <Icon className="h-5 w-5 text-action-primary" />}
            {title}
          </h2>
          {subtitle && <p className="mt-1 text-[0.9375rem] text-text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// This weekend = the upcoming Saturday 00:00 → Sunday 23:59 (local).
function weekendRange(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const day = now.getDay(); // 0 Sun … 6 Sat
  const daysToSat = (6 - day + 7) % 7;
  const sat = new Date(now);
  sat.setDate(now.getDate() + daysToSat);
  sat.setHours(0, 0, 0, 0);
  const sun = new Date(sat);
  sun.setDate(sat.getDate() + 1);
  sun.setHours(23, 59, 59, 0);
  return { dateFrom: sat.toISOString(), dateTo: sun.toISOString() };
}

export function DiscoverHome() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState<RecentEvent[]>([]);

  useEffect(() => setRecent(getRecent()), []);

  /*
    Where the customer said they are.

    This page ignored the header's city entirely, so choosing Bengaluru changed Browse and
    left the homepage — the page most people actually land on — showing Mumbai. The chip
    said one thing and the grid below it said another, which reads as the filter being
    broken, and it was.

    `cityScope` is shared with Browse and Movies so all three ask the same question: the
    chosen city if there is one, otherwise the country we think they are in, otherwise
    everywhere.
  */
  const preference = useCity();
  const scope = cityScope(preference);
  const scopedRecent = recent.filter((e) => inCityScope(e, preference));
  const scopeKey = JSON.stringify(scope);

  const categoriesQ = useQuery({
    queryKey: ['public-categories'],
    queryFn: () => api.publicCategories(),
  });
  const categories = useMemo(
    () => (categoriesQ.data ?? []).map((c) => c.category).slice(0, MAX_CATEGORY_CHIPS),
    [categoriesQ.data],
  );

  const featured = useQuery({
    queryKey: ['events', 'featured', scopeKey],
    queryFn: () => api.listEvents({ pageSize: '12', ...scope }),
  });

  const weekend = weekendRange();
  const weekendQ = useQuery({
    queryKey: ['events', 'weekend', scopeKey],
    queryFn: () =>
      api.listEvents({
        pageSize: '6',
        dateFrom: weekend.dateFrom,
        dateTo: weekend.dateTo,
        ...scope,
      }),
  });

  /** What the sections below are actually showing, for the copy that describes them. */
  const where = preference.city ?? preference.country ?? null;

  const freeEvents = useMemo(
    () => (featured.data?.data ?? []).filter((e) => e.fromPriceMinor === 0),
    [featured.data],
  );

  /**
   * Search suggestions: the categories that exist, plus the cities we can sell in.
   *
   * Both come from the server rather than from whatever happened to load into the grid
   * below. The previous version read cities out of the featured events, which meant the
   * suggestions changed depending on what had loaded and offered nothing at all before the
   * first fetch returned.
   */
  const suggestions = useMemo(
    () => [...categories, ...preference.topCities.map((c) => c.city)],
    [categories, preference.topCities],
  );

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    // Carries the city through, so searching from here lands on Browse already scoped the
    // way the header says it is — rather than silently widening back out to everywhere.
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (preference.city) params.set('city', preference.city);
    const query = params.toString();
    router.push(query ? `/events?${query}` : '/events');
  };

  return (
    <div className="space-y-16">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-[1.75rem] border border-border bg-background-surface px-6 py-16 text-center shadow-sm sm:py-20">
        <div className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-64 w-[36rem] max-w-full rounded-full bg-action-primary/10 blur-3xl" />
        <div className="relative mx-auto max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background-canvas px-3 py-1 text-caption font-medium text-text-secondary">
            <Sparkles className="h-3.5 w-3.5 text-action-primary" />
            Discover events worth showing up for
          </span>
          <h1 className="mt-6 text-h1 font-bold tracking-tight text-text-primary sm:text-hero">
            Find your next experience
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-[1.05rem] leading-relaxed text-text-secondary">
            Concerts, conferences, comedy and more — transparent pricing, instant QR tickets, no
            surprises.
          </p>

          <form onSubmit={search} className="mx-auto mt-8 flex max-w-xl gap-2" role="search">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted" />
              <input
                aria-label="Search events"
                list="search-suggestions"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search events, artists, cities…"
                className="w-full rounded-md border border-border bg-background-canvas py-3.5 pl-12 pr-4 text-[0.9375rem] text-text-primary shadow-sm placeholder:text-text-muted focus:border-ring focus:outline-none focus:ring-4 focus:ring-ring/15"
              />
              <datalist id="search-suggestions">
                {suggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <button
              type="submit"
              className="rounded-md bg-action-primary px-6 font-semibold text-action-primary-foreground shadow-sm transition-all hover:bg-action-primary-hover hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
            >
              Search
            </button>
          </form>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => router.push(`/events?category=${encodeURIComponent(c)}`)}
                className="rounded-full border border-border bg-background-surface px-4 py-1.5 text-caption font-medium text-text-secondary transition-all hover:border-border-strong hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/*
        Recently viewed, scoped like everything else on this page.

        It was the one list nothing filtered — read straight from this browser's history —
        so with Meridian chosen it offered a Hyderabad comedy show and a Mumbai gig directly
        under a header saying Meridian. The other sections were scoped correctly, which made
        it worse: the only events on screen were the out-of-scope ones, so the filtering
        looked broken precisely when it was working.

        Filtered rather than labelled: this strip is an invitation to act, and an invitation
        to a show eight thousand miles away is not one worth dressing up.
      */}
      {scopedRecent.length > 0 && (
        <Section title="Continue exploring" subtitle="Events you recently viewed." icon={Clock3}>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {scopedRecent.slice(0, 3).map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </div>
        </Section>
      )}

      {/* This weekend */}
      {weekendQ.data && weekendQ.data.data.length > 0 && (
        <Section
          title="This weekend"
          subtitle="Plans sorted — happening in the next few days."
          icon={Sparkles}
          action={
            <ButtonLink
              href={`/events?dateFrom=${weekend.dateFrom}&dateTo=${weekend.dateTo}`}
              variant="ghost"
            >
              View all →
            </ButtonLink>
          }
        >
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {weekendQ.data.data.map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </div>
        </Section>
      )}

      {/* Free events */}
      {freeEvents.length > 0 && (
        <Section title="Free events" subtitle="Great experiences, no ticket price.">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {freeEvents.map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </div>
        </Section>
      )}

      {/* Trending / featured */}
      <Section
        title={where ? `Happening in ${where}` : 'Trending now'}
        subtitle="Popular events people are booking."
        icon={TrendingUp}
        action={
          <ButtonLink href="/events" variant="ghost">
            View all →
          </ButtonLink>
        }
      >
        {featured.isLoading ? (
          <Skeletons />
        ) : featured.data && featured.data.data.length > 0 ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {featured.data.data.slice(0, 6).map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </div>
        ) : where ? (
          /*
            Empty because of WHERE, and it says so.

            "No events yet" on a page that has quietly been narrowed to one city is the
            single most misleading thing this product can say: the customer concludes the
            platform is dead when in fact there are fifteen events one city over. The way
            out is offered here rather than left to be rediscovered in the header.
          */
          <EmptyState
            title={`Nothing on in ${where} just yet`}
            hint="Other places have events on sale."
            icon={Sparkles}
            action={
              <Button variant="secondary" onClick={() => preference.setCity(null)}>
                Show me everywhere
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="No events yet"
            hint="Check back soon — new events land here first."
            icon={Sparkles}
          />
        )}
      </Section>

      {/* Collections by category */}
      <Section title="Explore by category" subtitle="Jump straight to what you love.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => router.push(`/events?category=${encodeURIComponent(c)}`)}
              className="group rounded-lg border border-border bg-background-surface p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
            >
              <p className="font-semibold text-text-primary group-hover:text-action-primary">{c}</p>
              <p className="mt-0.5 text-caption text-text-muted">Browse {c.toLowerCase()} →</p>
            </button>
          ))}
        </div>
      </Section>

      {/* Organizer CTA */}
      <section className="overflow-hidden rounded-lg border border-border bg-background-surface p-8 shadow-sm sm:p-10">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-h3 font-bold tracking-tight text-text-primary">
              Hosting an event?
            </h2>
            <p className="mt-2 max-w-lg text-[0.9375rem] text-text-secondary">
              Publish events, sell tickets, and check in guests with a beautiful organizer console.
            </p>
          </div>
          <ButtonLink
            href={process.env.NEXT_PUBLIC_ORGANIZER_URL ?? 'http://localhost:3001'}
            variant="primary"
          >
            Open organizer console
          </ButtonLink>
        </div>
      </section>
    </div>
  );
}
