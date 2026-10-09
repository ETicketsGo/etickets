'use client';

import { useQuery } from '@tanstack/react-query';
import { Link, useRouter } from '@/i18n/navigation';
import { useMemo, useState } from 'react';
import { Clock3, ReceiptText, Search, Sparkles, TrendingUp, Undo2, WifiOff } from 'lucide-react';
import { api } from '@/lib/api';
import { EventCard } from '@/components/event-card';
import { useRecentlyViewed } from '@/lib/use-live-events';
import { api as webKitApi, cityScope, countryPhrase, useCity } from '@eticketsgo/web-kit';
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
  // Current, still on sale, and in scope. One implementation, shared with Explore; see the hook.
  const { events: scopedRecent } = useRecentlyViewed(preference);
  const scopeKey = JSON.stringify(scope);

  const categoriesQ = useQuery({
    queryKey: ['public-categories'],
    queryFn: () => api.publicCategories(),
  });
  /*
    One chip per category, whatever case the rows are stored in.

    `/public/categories` groups on the raw string, so a platform holding both `Comedy` and
    `COMEDY` returns both - and the homepage offered the buyer two identical chips side by
    side, one shouting. It reads as a bug because it is one; the categories are the same
    category. The first spelling seen wins, the counts are added, and the order the endpoint
    chose (most events first) is preserved.

    Normalised HERE rather than in the API because the stored values are an organizer-facing
    data question and this is a display question. The API is not wrong to report what it has.
  */
  const categories = useMemo(() => {
    const bySlug = new Map<string, { label: string; count: number }>();
    for (const c of categoriesQ.data ?? []) {
      const key = c.category.trim().toLowerCase();
      if (!key) continue;
      const seen = bySlug.get(key);
      if (seen) seen.count += c.count;
      else bySlug.set(key, { label: c.category.trim(), count: c.count });
    }
    return [...bySlug.values()].map((c) => c.label).slice(0, MAX_CATEGORY_CHIPS);
  }, [categoriesQ.data]);

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

  /**
   * What the sections below are actually showing, for the copy that describes them.
   *
   * The country is named, not coded — "No events available in US yet" is a database row read
   * aloud. And it is tracked separately from the city because the way out of each differs:
   * leaving a city lands you in the rest of the country, which for a visitor whose country
   * we do not sell in yet is the same empty page they are already looking at.
   */
  /*
    Cities we actually sell in, asked for ONLY when the place we are showing has nothing.

    A visitor whose browser reports a region we do not sell in is scoped to that country, and
    `location/resolve` returns `topCities: []` for it - so the empty state offered "Search for
    a city" into a picker with nothing to suggest. That is a dead end on the front door.

    This is a search SUGGESTION, not a browse-everywhere button: it names the places that have
    something on, which is the question somebody in that position is actually asking.
  */
  const sellableCities = useQuery({
    queryKey: ['public-sellable-cities'],
    queryFn: () => webKitApi.location.cities({ limit: 6 }),
    enabled: (featured.data?.data.length ?? 0) === 0 && preference.topCities.length === 0,
  });

  /** Cities to offer when the place we are showing has nothing: ours first, then the API's. */
  const suggestedCities = (
    preference.topCities.length > 0 ? preference.topCities : (sellableCities.data ?? [])
  ).slice(0, 6);

  const whereCountry = preference.city ? null : preference.country;
  const where = preference.city ?? (whereCountry ? countryPhrase(whereCountry) : null);

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
            Concerts, conferences, comedy and more - transparent pricing, instant QR tickets, no
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
                placeholder="Search events, artists, cities..."
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
        Recently viewed: current, still on sale, and scoped like everything else on this page.

        It was the one list nothing filtered — read straight from this browser's history —
        so with Meridian chosen it offered a Hyderabad comedy show and a Mumbai gig directly
        under a header saying Meridian. The other sections were scoped correctly, which made
        it worse: the only events on screen were the out-of-scope ones, so the filtering
        looked broken precisely when it was working.

        See `useRecentlyViewed` for the second half of the same story: it was also the one list
        nothing kept up to date, so it went on advertising shows that were over.
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
          subtitle="Plans sorted - happening in the next few days."
          icon={Sparkles}
          action={
            <ButtonLink
              href={`/events?dateFrom=${weekend.dateFrom}&dateTo=${weekend.dateTo}`}
              variant="ghost"
            >
              View all
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
            View all
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
            title={`No events available in ${where} yet`}
            hint={
              whereCountry
                ? 'Here is where we are selling right now.'
                : 'Other places have events on sale.'
            }
            icon={Sparkles}
            action={
              whereCountry ? (
                /*
                  Name the places that have something, rather than offering an empty picker.

                  A visitor whose browser reports a region we do not sell in is scoped to that
                  country, and `location/resolve` answers with no suggestions at all - so the
                  only way out was to type a city name into a picker while being told there is
                  nothing on. That is a dead end on the front door, and the front door is the
                  one page that cannot have one.

                  These are search suggestions, not a browse-everywhere button: each chip is a
                  real city with tickets on sale today, and choosing one is the same action as
                  typing it.
                */
                <div className="flex flex-col items-center gap-3">
                  {suggestedCities.length > 0 && (
                    <div className="flex flex-wrap justify-center gap-2">
                      {suggestedCities.map((c) => (
                        <Button
                          key={`${c.country}-${c.city}`}
                          variant="secondary"
                          onClick={() => preference.setCity(c.city)}
                        >
                          {c.city}
                          <span className="ml-1.5 text-text-muted">{c.eventCount}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                  <Button variant="ghost" onClick={() => preference.requestPicker()}>
                    Search for another city
                  </Button>
                </div>
              ) : (
                <Button variant="secondary" onClick={() => preference.setCity(null)}>
                  Show me everywhere
                </Button>
              )
            }
          />
        ) : (
          <EmptyState
            title="No events yet"
            hint="Events appear here as soon as an organizer puts tickets on sale."
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
              <p className="mt-0.5 text-caption text-text-muted">Browse {c.toLowerCase()}</p>
            </button>
          ))}
        </div>
      </Section>

      {/*
        What a buyer needs to know before paying a stranger on the internet.

        The old homepage answered this with our own correctness properties - "we store amounts
        as whole units", "repeating a request does not charge twice". Those are true, and no
        buyer has ever chosen a ticketing site for its idempotency. These three are the
        questions somebody actually asks, and each one is a promise the product already keeps.

        Deliberately absent: who operates ETicketsGo, and where to write if something goes
        wrong. Both are real questions and neither has a published answer yet, so nothing here
        invents one. See docs/PRODUCTION_BUSINESS_DETAILS_CHECKLIST.md.
      */}
      <section className="rounded-lg border border-border bg-background-surface p-6 shadow-sm sm:p-8">
        <div className="grid gap-6 sm:grid-cols-3">
          {[
            {
              icon: ReceiptText,
              title: 'Every fee, before you pay',
              body: 'The total on the event page is the total you are charged. Each fee is listed on its own line.',
            },
            {
              icon: WifiOff,
              title: 'Your ticket works without a signal',
              body: 'The QR code is on your phone and scans at the gate even when the venue network does not.',
            },
            {
              icon: Undo2,
              title: 'The refund window is on the event',
              body: 'Before you buy, the event page says whether you can get your money back, and until when.',
            },
          ].map((t) => (
            <div key={t.title}>
              <t.icon className="h-5 w-5 text-action-primary" aria-hidden />
              <h3 className="mt-3 text-[0.9375rem] font-semibold text-text-primary">{t.title}</h3>
              <p className="mt-1 text-caption leading-relaxed text-text-secondary">{t.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-4 text-caption">
          <Link href="/refunds" className="text-action-primary hover:underline">
            Refund policy
          </Link>
          <Link href="/terms" className="text-action-primary hover:underline">
            Terms
          </Link>
          <Link href="/privacy" className="text-action-primary hover:underline">
            Privacy
          </Link>
          <Link href="/contact" className="text-action-primary hover:underline">
            Contact us
          </Link>
        </div>
      </section>

      {/*
        The organizer path, kept and demoted.

        It used to send a stranger to `NEXT_PUBLIC_ORGANIZER_URL ?? 'http://localhost:3001'` -
        a console they have no account for, and a localhost address if that variable is ever
        unset. Somebody who has not signed up wants to read what we offer first, which is what
        `/organizers` is for.
      */}
      <section className="overflow-hidden rounded-lg border border-border bg-background-surface p-8 shadow-sm sm:p-10">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-h3 font-bold tracking-tight text-text-primary">
              Run events of your own?
            </h2>
            <p className="mt-2 max-w-lg text-[0.9375rem] text-text-secondary">
              Sell tickets, reserve seats and check people in at the gate - including when the venue
              network drops.
            </p>
          </div>
          <ButtonLink href="/organizers" variant="secondary">
            See how it works
          </ButtonLink>
        </div>
      </section>
    </div>
  );
}
