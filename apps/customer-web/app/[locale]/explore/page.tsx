'use client';

import { useQuery } from '@tanstack/react-query';
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
import { cityScope, countryPhrase, useCity } from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import type {
  DiscoverySection,
  OrganizerSpotlight,
  PublicEventCard,
  PublicMovieCard,
  VenueSpotlight,
} from '@/lib/api';
import { useRecentlyViewed } from '@/lib/use-live-events';
import { EventCard } from '@/components/event-card';
import { MovieCard } from '@/components/movie-card';
import { Button, ButtonLink, EmptyState, ErrorState } from '@/components/ui';
import { Link } from '@/i18n/navigation';

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
      {label}
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
      /*
        `min-w-0` on the LINK, not only on the text inside it.

        Without it this tile was 423px wide inside a 379px column on a phone - the 44px icon
        added on top of a text block that never agreed to shrink - and Explore was the one
        storefront page that scrolled sideways. A flex row only lets its children shrink when
        the row itself is allowed to.
      */
      className="group flex min-w-0 items-center gap-3 rounded-lg border border-border bg-background-surface p-4 shadow-sm transition-all duration-300 ease-premium hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-tint-primary text-action-primary">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
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
          meta={`${o.eventCount} event${o.eventCount === 1 ? '' : 's'}${o.verified ? ', verified' : ''}`}
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
          meta={`${v.city}, ${v.eventCount} event${v.eventCount === 1 ? '' : 's'}`}
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
  /*
    Where the visitor is browsing: the chosen city, else their country, else nowhere.

    Every list on this page is asked for this place, as every other page on the storefront
    already was. Explore used to ask the top half for nothing and the lower half for a city
    only, so a visitor who had not picked a city - every visitor, at first - was shown every
    country. The owner opened it from the United States and got Hyderabad, Mumbai, Boise and
    Meridian on one screen.
  */
  const preference = useCity();
  const scope = cityScope(preference);
  const scopeKey = JSON.stringify(scope);
  const where = preference.city ?? (preference.country ? countryPhrase(preference.country) : null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['discovery', scopeKey],
    queryFn: () => api.discovery(scope),
  });

  // Composed strategy sections (organizers/venues/nearby/new-releases/...), for the same place.
  // An empty place gets an empty feed: there is no "here is everywhere instead" any more.
  const sectionsQuery = useQuery({
    queryKey: ['discovery-sections', scopeKey],
    queryFn: () => api.discoverySectionFeed(scope),
  });
  const feed = sectionsQuery.data;
  const extraSections = (feed?.sections ?? []).filter(
    (s) => s.key !== 'trending' && s.key !== 'weekend',
  );

  /*
    Recently viewed: current, still on sale, and in this place.

    This page used to render the copies stored in the browser as they were - which is how the
    owner saw shows from 6 to 19 September, all over, at the top of Explore. It now shares one
    implementation with the home page; see `useRecentlyViewed`.
  */
  const { events: recent } = useRecentlyViewed(preference);
  // "Continue exploring": the categories of those same events, so it cannot disagree with them.
  const recentCategories = Array.from(new Set(recent.map((e) => e.category))).slice(0, 8);

  /*
    Nothing at all on sale here. Said once, plainly, with the one control that helps - instead
    of four separate empty sections each apologising for the same fact.
  */
  const nothingHere =
    Boolean(data) &&
    Boolean(feed) &&
    data!.nowShowing.length === 0 &&
    data!.trendingEvents.length === 0 &&
    data!.thisWeekend.length === 0 &&
    extraSections.length === 0;

  return (
    <div className="space-y-16">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-[1.75rem] border border-border bg-background-surface px-6 py-14 text-center shadow-sm sm:py-16">
        <div className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-64 w-[36rem] max-w-full rounded-full bg-action-primary/10 blur-3xl" />
        <div className="relative mx-auto max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background-canvas px-3 py-1 text-caption font-medium text-text-secondary">
            <Compass className="h-3.5 w-3.5 text-action-primary" />
            Explore what is on
          </span>
          <h1 className="mt-6 text-h1 font-bold tracking-tight text-text-primary sm:text-hero">
            Movies, events, and more
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-[1.05rem] leading-relaxed text-text-secondary">
            Films playing now, events people are booking, and things to do this weekend.
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
          message="We could not load this page. Please try again."
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
      ) : nothingHere && where ? (
        <EmptyState
          title={`Nothing on in ${where} just yet`}
          hint="Search for a city to see what is on there."
          icon={Compass}
          action={
            <Button variant="secondary" onClick={() => preference.requestPicker()}>
              Search for a city
            </Button>
          }
        />
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
                title={where ? `No films showing in ${where} yet` : 'No films showing yet'}
                hint="We list films here as soon as a cinema adds showtimes."
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
                title={where ? `No popular events in ${where} yet` : 'No popular events yet'}
                hint="Events appear here once people start booking them."
                icon={Sparkles}
                action={<ButtonLink href="/events">Browse events</ButtonLink>}
              />
            )}
          </Section>

          {/* This weekend — hidden when empty */}
          {data && data.thisWeekend.length > 0 && (
            <Section
              title="This weekend"
              subtitle="Happening in the next few days."
              icon={Sparkles}
              action={<SeeAllLink href="/events" />}
            >
              <EventGrid items={data.thisWeekend} />
            </Section>
          )}

          {/* Composed strategy sections (organizer/venue spotlights, new releases, …). */}
          {extraSections.map((section) => (
            <DynamicSection key={section.key} section={section} />
          ))}

          {/* Browse by category — hidden when empty */}
          {data && data.categories.length > 0 && (
            <Section
              title="Browse by category"
              subtitle="Jump straight to a category."
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
              subtitle="Categories you have been browsing."
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
