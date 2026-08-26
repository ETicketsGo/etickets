'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Building2,
  Clapperboard,
  Compass,
  Film,
  History,
  Sparkles,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useCity } from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import type {
  DiscoverySection,
  OrganizerSpotlight,
  PublicEventCard,
  PublicMovieCard,
  VenueSpotlight,
} from '@/lib/api';
import { getRecent, type RecentEvent } from '@/lib/recent';
import { EventCard } from '@/components/event-card';
import { MovieCard } from '@/components/movie-card';
import { ButtonLink, EmptyState, ErrorState } from '@/components/ui';

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

function EventSkeletons({ count = 6 }: { count?: number }) {
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

function MovieSkeletons({ count = 5 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="aspect-[2/3] animate-pulse rounded-lg border border-border bg-background-subtle"
        />
      ))}
    </div>
  );
}

function SeeAllLink({ href, label = 'See all' }: { href: string; label?: string }) {
  return (
    <ButtonLink href={href} variant="ghost">
      {label} →
    </ButtonLink>
  );
}

function EventGrid({ items }: { items: PublicEventCard[] }) {
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((e) => (
        <EventCard key={e.id} event={e} />
      ))}
    </div>
  );
}

function MovieGrid({ items }: { items: PublicMovieCard[] }) {
  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((m) => (
        <MovieCard key={m.id} movie={m} />
      ))}
    </div>
  );
}

/** Lightweight organizer/venue tiles — reuse existing surface/border styling. */
function SpotlightTile({
  href,
  title,
  meta,
  icon: Icon,
}: {
  href: string;
  title: string;
  meta: string;
  icon: typeof Users;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-lg border border-border bg-background-surface p-4 shadow-sm transition-all duration-300 ease-premium hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-action-primary/10 text-action-primary">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-title font-semibold text-text-primary transition-colors group-hover:text-action-primary">
          {title}
        </span>
        <span className="block truncate text-caption text-text-muted">{meta}</span>
      </span>
    </Link>
  );
}

function OrganizerList({ items }: { items: OrganizerSpotlight[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((o) => (
        <SpotlightTile
          key={o.id}
          href={`/organizers/${o.id}`}
          title={o.name}
          meta={`${o.eventCount} event${o.eventCount === 1 ? '' : 's'}${o.verified ? ' · Verified' : ''}`}
          icon={Users}
        />
      ))}
    </div>
  );
}

function VenueList({ items }: { items: VenueSpotlight[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((v) => (
        <SpotlightTile
          key={v.id}
          href={`/events?city=${encodeURIComponent(v.city)}`}
          title={v.name}
          meta={`${v.city} · ${v.eventCount} event${v.eventCount === 1 ? '' : 's'}`}
          icon={Building2}
        />
      ))}
    </div>
  );
}

const SECTION_ICON: Record<DiscoverySection['kind'], typeof Sparkles> = {
  events: TrendingUp,
  movies: Clapperboard,
  organizers: Users,
  venues: Building2,
};

/** Render one composed strategy section, choosing the layout by kind. */
function DynamicSection({ section }: { section: DiscoverySection }) {
  const icon = SECTION_ICON[section.kind];
  let body: React.ReactNode;
  switch (section.kind) {
    case 'movies':
      body = <MovieGrid items={section.items as PublicMovieCard[]} />;
      break;
    case 'organizers':
      body = <OrganizerList items={section.items as OrganizerSpotlight[]} />;
      break;
    case 'venues':
      body = <VenueList items={section.items as VenueSpotlight[]} />;
      break;
    case 'events':
    default:
      body = <EventGrid items={section.items as PublicEventCard[]} />;
      break;
  }
  return (
    <Section title={section.title} icon={icon}>
      {body}
    </Section>
  );
}

export default function ExplorePage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['discovery'],
    queryFn: () => api.discovery(),
  });

  // Composed strategy sections (organizers/venues/nearby/new-releases/…), scoped to the
  // city in the header. The feed reports what it actually applied, because a city with no
  // inventory falls back to everywhere and the customer deserves to be told that.
  const { city } = useCity();
  const sectionsQuery = useQuery({
    queryKey: ['discovery-sections', city],
    queryFn: () => api.discoverySectionFeed(city ?? undefined),
  });
  const feed = sectionsQuery.data;

  // Client-only personalisation from the localStorage recent store. Read after
  // mount to avoid a hydration mismatch (localStorage is unavailable on server).
  const [recent, setRecent] = useState<RecentEvent[]>([]);
  useEffect(() => setRecent(getRecent()), []);
  // "Continue exploring" = the distinct categories of recently-viewed events.
  const recentCategories = Array.from(new Set(recent.map((e) => e.category))).slice(0, 8);

  return (
    <div className="space-y-16">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-[1.75rem] border border-border bg-background-surface px-6 py-14 text-center shadow-sm sm:py-16">
        <div className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-64 w-[36rem] max-w-full rounded-full bg-action-primary/10 blur-3xl" />
        <div className="relative mx-auto max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background-canvas px-3 py-1 text-caption font-medium text-text-secondary">
            <Compass className="h-3.5 w-3.5 text-action-primary" />
            Explore what’s on
          </span>
          <h1 className="mt-6 text-h1 font-bold tracking-tight text-text-primary sm:text-hero">
            Movies, events, and more
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-[1.05rem] leading-relaxed text-text-secondary">
            A hand-picked mix of what’s showing now, what’s trending, and plans for the weekend —
            all in one place.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
            <ButtonLink href="/movies" variant="primary">
              Browse movies
            </ButtonLink>
            <ButtonLink href="/events" variant="outline">
              Browse events
            </ButtonLink>
          </div>
        </div>
      </section>

      {/* Recently viewed — client-side, hidden when empty */}
      {recent.length > 0 && (
        <Section title="Recently viewed" subtitle="Pick up where you left off." icon={History}>
          <EventGrid items={recent} />
        </Section>
      )}

      {isError ? (
        <ErrorState
          message="We couldn't load your discovery feed. Please try again."
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <div className="space-y-16">
          <Section title="Now showing" icon={Clapperboard}>
            <MovieSkeletons />
          </Section>
          <Section title="Trending events" icon={TrendingUp}>
            <EventSkeletons />
          </Section>
        </div>
      ) : (
        <div className="space-y-16">
          {/* Now showing */}
          <Section
            title="Now showing"
            subtitle="Films playing near you right now."
            icon={Clapperboard}
            action={
              data && data.nowShowing.length > 0 ? (
                <SeeAllLink href="/movies" label="See all movies" />
              ) : undefined
            }
          >
            {data && data.nowShowing.length > 0 ? (
              <MovieGrid items={data.nowShowing} />
            ) : (
              <EmptyState
                title="No movies showing yet"
                hint="New releases land here first — check back soon."
                icon={Film}
                action={<ButtonLink href="/movies">Browse movies</ButtonLink>}
              />
            )}
          </Section>

          {/* Trending events */}
          <Section
            title="Trending events"
            subtitle="Popular events people are booking."
            icon={TrendingUp}
            action={
              data && data.trendingEvents.length > 0 ? <SeeAllLink href="/events" /> : undefined
            }
          >
            {data && data.trendingEvents.length > 0 ? (
              <EventGrid items={data.trendingEvents} />
            ) : (
              <EmptyState
                title="No trending events yet"
                hint="Check back soon — new events land here first."
                icon={Sparkles}
                action={<ButtonLink href="/events">Browse events</ButtonLink>}
              />
            )}
          </Section>

          {/* This weekend — hidden when empty */}
          {data && data.thisWeekend.length > 0 && (
            <Section
              title="This weekend"
              subtitle="Plans sorted — happening in the next few days."
              icon={Sparkles}
              action={<SeeAllLink href="/events" />}
            >
              <EventGrid items={data.thisWeekend} />
            </Section>
          )}

          {/* Composed strategy sections (organizer/venue spotlights, new releases, …). */}
          {feed?.fellBackToAllCities ? (
            <p className="rounded-lg border border-border bg-background-subtle px-4 py-3 text-[0.9375rem] text-text-secondary">
              Nothing on sale in <strong className="text-text-primary">{city}</strong> just yet —
              showing everywhere instead.
            </p>
          ) : null}

          {feed?.sections
            .filter((s) => s.key !== 'trending' && s.key !== 'weekend')
            .map((section) => (
              <DynamicSection key={section.key} section={section} />
            ))}

          {/* Browse by category — hidden when empty */}
          {data && data.categories.length > 0 && (
            <Section
              title="Browse by category"
              subtitle="Jump straight to what you love."
              icon={Compass}
            >
              <div className="flex flex-wrap gap-2.5">
                {data.categories.map((c) => (
                  <Link
                    key={c}
                    href={`/events?category=${encodeURIComponent(c)}`}
                    className="rounded-full border border-border bg-background-surface px-4 py-2 text-[0.9375rem] font-medium text-text-secondary shadow-sm transition-all hover:border-border-strong hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
                  >
                    {c}
                  </Link>
                ))}
              </div>
            </Section>
          )}

          {/* Continue exploring — client-side, from recently-viewed categories */}
          {recentCategories.length > 0 && (
            <Section
              title="Continue exploring"
              subtitle="Categories you’ve been browsing."
              icon={Compass}
            >
              <div className="flex flex-wrap gap-2.5">
                {recentCategories.map((c) => (
                  <Link
                    key={c}
                    href={`/events?category=${encodeURIComponent(c)}`}
                    className="rounded-full border border-border bg-background-surface px-4 py-2 text-[0.9375rem] font-medium text-text-secondary shadow-sm transition-all hover:border-border-strong hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
                  >
                    {c}
                  </Link>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
