'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Clock3, Search, Sparkles, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { EventCard } from '@/components/event-card';
import { getRecent, type RecentEvent } from '@/lib/recent';
import { ButtonLink, EmptyState } from '@/components/ui';

const CATEGORIES = ['Music', 'Tech', 'Comedy', 'Sports', 'Theatre'];
const CITIES = ['Bengaluru', 'Mumbai', 'Delhi', 'Hyderabad', 'Pune'];

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

export default function HomePage() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState<RecentEvent[]>([]);

  useEffect(() => setRecent(getRecent()), []);

  const featured = useQuery({
    queryKey: ['events', 'featured'],
    queryFn: () => api.listEvents({ pageSize: '12' }),
  });

  const weekend = weekendRange();
  const weekendQ = useQuery({
    queryKey: ['events', 'weekend'],
    queryFn: () =>
      api.listEvents({ pageSize: '6', dateFrom: weekend.dateFrom, dateTo: weekend.dateTo }),
  });

  const freeEvents = useMemo(
    () => (featured.data?.data ?? []).filter((e) => e.fromPriceMinor === 0),
    [featured.data],
  );

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    router.push(q.trim() ? `/events?q=${encodeURIComponent(q.trim())}` : '/events');
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
                {[...CATEGORIES, ...CITIES].map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <button
              type="submit"
              className="rounded-md bg-action-primary px-6 font-semibold text-action-primary-foreground shadow-sm transition-all hover:bg-action-primary-hover hover:shadow-md active:scale-[0.98]"
            >
              Search
            </button>
          </form>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => router.push(`/events?category=${encodeURIComponent(c)}`)}
                className="rounded-full border border-border bg-background-surface px-4 py-1.5 text-caption font-medium text-text-secondary transition-all hover:border-border-strong hover:bg-background-subtle hover:text-text-primary"
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Recently viewed */}
      {recent.length > 0 && (
        <Section title="Continue exploring" subtitle="Events you recently viewed." icon={Clock3}>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {recent.slice(0, 3).map((e) => (
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
        title="Trending now"
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
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => router.push(`/events?category=${encodeURIComponent(c)}`)}
              className="group rounded-lg border border-border bg-background-surface p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
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
          <ButtonLink href="http://localhost:3001" variant="primary">
            Open organizer console
          </ButtonLink>
        </div>
      </section>
    </div>
  );
}
