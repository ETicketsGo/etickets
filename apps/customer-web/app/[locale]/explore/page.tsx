'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  BrandButton,
  brandButtonClasses,
  brandChipClasses,
  BRAND_FOCUS,
  cityScope,
  countryKey,
  selectedPlace,
  useCity,
} from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import type {
  DiscoverySection,
  OrganizerSpotlight,
  PublicEventCard,
  PublicMovieCard,
  VenueSpotlight,
} from '@/lib/api';
import type { Buyability } from '@/lib/home-feed';
import { hasPhoto } from '@/lib/home-feed';
import { useBuyability } from '@/lib/use-buyability';
import { useCountryWords } from '@/lib/country-words';
import { useRecentlyViewed } from '@/lib/use-live-events';
import { usePlaceGroups } from '@/lib/use-place-groups';
import { EmptyPlace, PlaceSections } from '@/components/place-sections';
import {
  EventRow,
  EventTile,
  FeatureCard,
  Placeholder,
  PosterCard,
  Rail,
  RailItem,
  SectionHead,
  sectionLinkClasses,
} from '@/components/home/parts';
import {
  BRAND_WRAP,
  BrandEmpty,
  BrandPage,
  FilmCard,
  SaveEventButton,
} from '@/components/storefront-brand';
import { Link } from '@/i18n/navigation';

/*
  ── EXPLORE ON THE STAGE (docs/design/DESIGN-SYSTEM.md) ─────────────────────────────────
  What it replaced: a white box with a blurred blue glow and a badge, then every section as the
  same three-column grid of shadowed cards with pastel letter tiles - eight uniform grids in a
  row, about 13,500px tall at 1440 and 27,000px on a phone. It read as a different product from
  the home page one click away.

  What it is now: the same pieces as the home page. A paper header with the page's one primary
  action, the films on a stage band as posters, the trending list as a 16:9 feature beside a
  4:3 list, and every other list as a rail that scrolls inside itself on a phone (and becomes a
  grid from `lg`). Same lists, same order, same data as before; only how they are drawn changed.

  A card shows its price only once the event's own page proves a ticket is on sale (see
  `useBuyability`), exactly as on the home page: "From Rs 799" over a sold-out show was the
  misleading price that rule exists to prevent.
*/

type States = Map<string, Buyability | undefined>;

/** A 4:3 event card with the wishlist heart over its picture. */
function Tile({
  event,
  states,
  showCity = false,
}: {
  event: PublicEventCard;
  states: States;
  showCity?: boolean;
}) {
  return (
    <div className="relative">
      <EventTile event={event} state={states.get(event.slug)} showCity={showCity} />
      <SaveEventButton event={event} />
    </div>
  );
}

function EventRail({
  items,
  label,
  states,
  showCity = false,
}: {
  items: PublicEventCard[];
  label: string;
  states: States;
  showCity?: boolean;
}) {
  return (
    <Rail cols={4} label={label}>
      {items.map((e) => (
        <RailItem key={e.id}>
          <Tile event={e} states={states} showCity={showCity} />
        </RailItem>
      ))}
    </Rail>
  );
}

function FilmRail({ items, label }: { items: PublicMovieCard[]; label: string }) {
  return (
    <Rail cols={5} phone="poster" label={label}>
      {items.map((m) => (
        <RailItem key={m.id}>
          <FilmCard movie={m} />
        </RailItem>
      ))}
    </Rail>
  );
}

/**
 * The lead list: a 16:9 feature beside 4:3 rows when the first event has a photo, rows alone
 * when it does not (a 16:9 block of title-on-black above the same title read as a broken
 * picture on the home page, for the same reason).
 */
function LeadList({ items, states }: { items: PublicEventCard[]; states: States }) {
  if (!hasPhoto(items[0])) {
    return (
      <ul className="grid gap-x-10 divide-y divide-brand-line lg:grid-cols-2 lg:divide-y-0">
        {items.map((e) => (
          <li key={e.id} className="lg:border-b lg:border-brand-line">
            <EventRow event={e} state={states.get(e.slug)} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="grid gap-8 lg:grid-cols-[7fr_5fr] lg:gap-10">
      <div className="relative">
        <FeatureCard event={items[0]} state={states.get(items[0].slug)} />
        <SaveEventButton event={items[0]} />
      </div>
      {items.length > 1 && (
        <ul className="divide-y divide-brand-line lg:-mt-4">
          {items.slice(1).map((e) => (
            <li key={e.id}>
              <EventRow event={e} state={states.get(e.slug)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Organizers and venues as a quiet list of rows: a name, a fact, and where it goes. */
function SpotlightList({
  items,
  label,
}: {
  items: { key: string; href: string; title: string; meta: string }[];
  label: string;
}) {
  return (
    <ul
      aria-label={label}
      className="grid gap-x-8 border-t border-brand-line sm:grid-cols-2 lg:grid-cols-3"
    >
      {items.map((item) => (
        <li key={item.key} className="min-w-0 border-b border-brand-line">
          <Link
            href={item.href}
            /*
              `min-w-0` on the LINK, not only on the text inside it: a flex row only lets its
              children shrink when the row itself is allowed to, and without it this was the
              one storefront row that pushed a phone sideways.
            */
            className={`group flex min-h-16 min-w-0 items-center gap-3 rounded-brand-control py-3 ${BRAND_FOCUS}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-brand-display text-brand-card text-brand-ink">
                {item.title}
              </span>
              <span className="block truncate text-brand-meta text-brand-ink-2">{item.meta}</span>
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-brand-ink-3 transition-transform duration-150 motion-safe:group-hover:translate-x-0.5"
              aria-hidden
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The `storefront.explore` messages, as `useTranslations` hands them to the page. */
type Explore = (key: string, values?: Record<string, string | number>) => string;

function organizerRows(items: OrganizerSpotlight[], t: Explore) {
  return items.map((o) => ({
    key: o.id,
    href: `/organizers/${o.id}`,
    title: o.name,
    meta: t(o.verified ? 'organizerMetaVerified' : 'organizerMeta', { count: o.eventCount }),
  }));
}

function venueRows(items: VenueSpotlight[], t: Explore) {
  return items.map((v) => ({
    key: v.id,
    href: `/events?city=${encodeURIComponent(v.city)}`,
    title: v.name,
    meta: t('venueMeta', { city: v.city, count: v.eventCount }),
  }));
}

/*
  The API titles its composed sections in English ("Organizer spotlight"). The key is the
  stable part, so the title a reader sees comes from the catalogue by key; a section this page
  does not know yet keeps the API's title rather than showing nothing.
*/
const SECTION_TITLES: Record<string, string> = {
  'new-releases': 'sectionNewReleases',
  'organizer-spotlight': 'sectionOrganizerSpotlight',
  popular: 'sectionPopular',
  recommended: 'sectionRecommended',
  'venue-spotlight': 'sectionVenueSpotlight',
  trending: 'sectionTrending',
  weekend: 'sectionWeekend',
};

function sectionTitle(section: DiscoverySection, t: Explore): string {
  if (section.key === 'nearby') {
    // "Near you in <city>": the city is the API's own, read back out of its title.
    const city = /^Near you in (.+)$/.exec(section.title)?.[1];
    return city ? t('sectionNearbyIn', { city }) : t('sectionNearby');
  }
  const key = SECTION_TITLES[section.key];
  return key ? t(key) : section.title;
}

/** One composed strategy section, drawn by kind. */
function DynamicSection({ section, states }: { section: DiscoverySection; states: States }) {
  const t = useTranslations('storefront.explore');
  const id = `explore-${section.key}`;
  const title = sectionTitle(section, t);
  let body: React.ReactNode;
  switch (section.kind) {
    case 'movies':
      body = <FilmRail items={section.items as PublicMovieCard[]} label={title} />;
      break;
    case 'organizers':
      body = (
        <SpotlightList
          items={organizerRows(section.items as OrganizerSpotlight[], t)}
          label={title}
        />
      );
      break;
    case 'venues':
      body = (
        <SpotlightList items={venueRows(section.items as VenueSpotlight[], t)} label={title} />
      );
      break;
    case 'events':
    default:
      body = <EventRail items={section.items as PublicEventCard[]} label={title} states={states} />;
      break;
  }
  return (
    <section aria-labelledby={id} className={`${BRAND_WRAP} pt-12 lg:pt-16`}>
      <SectionHead id={id} title={title} />
      {body}
    </section>
  );
}

/** Category links as chips that wrap: a short list a person scans, not a rail. */
function CategoryChips({ items, label }: { items: string[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-2">
      {items.map((c) => (
        <li key={c}>
          <Link
            href={`/events?category=${encodeURIComponent(c)}`}
            className={`${brandChipClasses(false)} h-11 lg:h-9`}
          >
            {c}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function ExplorePage() {
  const t = useTranslations('storefront.explore');
  const action = useTranslations('common.action');
  const common = useTranslations('common.state');
  const words = useCountryWords();
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
  // The selected city names the page; with none, the country the page is scoped to.
  const where = preference.city ?? (preference.country ? words(preference.country, true) : null);
  const place = selectedPlace(preference);

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
    What is on beyond the selected city: the rest of its country, then each other country under
    its own title (one small read per group). Nothing is asked for when no place is chosen,
    because there is then nothing to be "elsewhere" from.
  */
  const groups = usePlaceGroups(place);
  const placeSections = { ...groups, homeCountry: countryKey(place.country) };
  const hasGroups = groups.sameCountry.length > 0 || groups.elsewhere.length > 0;

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

  // Every event card on the page, in page order, so the first ones are checked first.
  const states = useBuyability([
    ...recent.map((e) => e.slug),
    ...(data?.trendingEvents ?? []).map((e) => e.slug),
    ...(data?.thisWeekend ?? []).map((e) => e.slug),
    ...extraSections
      .filter((s) => s.kind === 'events')
      .flatMap((s) => (s.items as PublicEventCard[]).map((e) => e.slug)),
    ...groups.sameCountry.slice(0, 6).map((e) => e.slug),
    ...groups.elsewhere.flatMap((g) => g.items.slice(0, 6).map((e) => e.slug)),
  ]);

  return (
    <BrandPage>
      {/*
        What this page is, and its one primary action, on paper. The films right under it are the
        stage band; two dark bands with a strip of paper between them read as a rendering fault.
      */}
      <section>
        <div className={`${BRAND_WRAP} pt-8 lg:pt-14`}>
          <p className="text-brand-eyebrow uppercase text-brand-ink-3">{t('eyebrow')}</p>
          <h1 className="mt-3 max-w-3xl text-balance font-brand-display text-brand-d1 text-brand-ink">
            {t('title')}
          </h1>
          <p className="mt-4 max-w-prose text-brand-lead text-brand-ink-2">{t('lead')}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/movies" className={brandButtonClasses('primary', 'lg')}>
              {t('browseMovies')}
            </Link>
            <Link href="/events" className={brandButtonClasses('secondary', 'lg')}>
              {t('browseEvents')}
            </Link>
          </div>
        </div>
      </section>

      {/* Recently viewed - client-side, hidden when empty */}
      {recent.length > 0 && (
        <section aria-labelledby="explore-recent" className={`${BRAND_WRAP} pt-12 lg:pt-16`}>
          <SectionHead id="explore-recent" title={t('recentTitle')} hint={t('recentHint')} />
          <EventRail items={recent} label={t('recentTitle')} states={states} />
        </section>
      )}

      {isError ? (
        <div className={`${BRAND_WRAP} pt-12 lg:pt-16`}>
          <BrandEmpty
            title={t('loadError')}
            action={
              <BrandButton variant="secondary" onClick={() => void refetch()}>
                {action('retry')}
              </BrandButton>
            }
          />
        </div>
      ) : isLoading ? (
        <div className={`${BRAND_WRAP} space-y-12 pt-12 lg:pt-16`} aria-busy="true">
          <span className="sr-only" role="status">
            {common('loading')}
          </span>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 lg:gap-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Placeholder key={i} className="aspect-[2/3] w-full" />
            ))}
          </div>
          <div className="grid gap-8 lg:grid-cols-[7fr_5fr]">
            <Placeholder className="aspect-video w-full" />
            <div className="space-y-4">
              <Placeholder className="h-20 w-full" />
              <Placeholder className="h-20 w-full" />
              <Placeholder className="h-20 w-full" />
            </div>
          </div>
        </div>
      ) : nothingHere && where ? (
        <div className={`${BRAND_WRAP} pt-12 lg:pt-16`}>
          <EmptyPlace place={where} variant="brand" />
        </div>
      ) : (
        <>
          {/* Now showing: posters on a stage band, as on the home page. */}
          {data && data.nowShowing.length > 0 ? (
            <section
              data-brand-tone="stage"
              aria-labelledby="explore-films"
              className="mt-12 bg-brand-canvas py-12 lg:mt-16 lg:py-16"
            >
              <div className={BRAND_WRAP}>
                <SectionHead
                  id="explore-films"
                  title={t('nowShowing')}
                  hint={t('nowShowingHint')}
                  action={
                    <Link href="/movies" className={sectionLinkClasses()}>
                      {t('seeAllMovies')}
                    </Link>
                  }
                />
                <Rail cols={5} phone="poster" label={t('nowShowing')}>
                  {data.nowShowing.map((m) => (
                    <RailItem key={m.id}>
                      <PosterCard movie={m} />
                    </RailItem>
                  ))}
                </Rail>
              </div>
            </section>
          ) : (
            <section aria-labelledby="explore-films" className={`${BRAND_WRAP} pt-12 lg:pt-16`}>
              <SectionHead id="explore-films" title={t('nowShowing')} />
              <BrandEmpty
                title={where ? t('noFilmsIn', { place: where }) : t('noFilms')}
                hint={t('noFilmsHint')}
                action={
                  <Link href="/movies" className={brandButtonClasses('secondary', 'md')}>
                    {t('browseMovies')}
                  </Link>
                }
              />
            </section>
          )}

          {/* Trending events: the lead of the page, a feature beside a list. */}
          <section aria-labelledby="explore-trending" className={`${BRAND_WRAP} pt-12 lg:pt-16`}>
            <SectionHead
              id="explore-trending"
              title={t('trendingTitle')}
              hint={t('trendingHint')}
              action={
                data && data.trendingEvents.length > 0 ? (
                  <Link href="/events" className={sectionLinkClasses()}>
                    {t('seeAll')}
                  </Link>
                ) : undefined
              }
            />
            {data && data.trendingEvents.length > 0 ? (
              <LeadList items={data.trendingEvents} states={states} />
            ) : (
              <BrandEmpty
                title={where ? t('noPopularIn', { place: where }) : t('noPopular')}
                hint={t('noPopularHint')}
                action={
                  <Link href="/events" className={brandButtonClasses('secondary', 'md')}>
                    {t('browseEvents')}
                  </Link>
                }
              />
            )}
          </section>

          {/* This weekend - hidden when empty */}
          {data && data.thisWeekend.length > 0 && (
            <section aria-labelledby="explore-weekend" className={`${BRAND_WRAP} pt-12 lg:pt-16`}>
              <SectionHead
                id="explore-weekend"
                title={t('weekendTitle')}
                hint={t('weekendHint')}
                action={
                  <Link href="/events" className={sectionLinkClasses()}>
                    {t('seeAll')}
                  </Link>
                }
              />
              <EventRail items={data.thisWeekend} label={t('weekendTitle')} states={states} />
            </section>
          )}

          {/* Composed strategy sections (organizer/venue spotlights, new releases, ...). */}
          {extraSections.map((section) => (
            <DynamicSection key={section.key} section={section} states={states} />
          ))}

          {/* Browse by category - hidden when empty */}
          {data && data.categories.length > 0 && (
            <section
              aria-labelledby="explore-categories"
              className={`${BRAND_WRAP} pt-12 lg:pt-16`}
            >
              <SectionHead
                id="explore-categories"
                title={t('categoriesTitle')}
                hint={t('categoriesHint')}
              />
              <CategoryChips items={data.categories} label={t('categoriesTitle')} />
            </section>
          )}

          {/* Continue exploring - client-side, from recently-viewed categories */}
          {recentCategories.length > 0 && (
            <section aria-labelledby="explore-continue" className={`${BRAND_WRAP} pt-12 lg:pt-16`}>
              <SectionHead
                id="explore-continue"
                title={t('continueTitle')}
                hint={t('continueHint')}
              />
              <CategoryChips items={recentCategories} label={t('continueTitle')} />
            </section>
          )}
        </>
      )}

      {/* Beyond the selected city: the rest of its country, then the world, by country. */}
      {!isLoading && !isError && (
        <div
          className={`${BRAND_WRAP} space-y-12 lg:space-y-16 ${hasGroups ? 'pt-12 lg:pt-16' : ''}`}
          data-testid="place-groups"
        >
          <PlaceSections
            variant="brand"
            buckets={placeSections}
            currencyOf={(e) => e.currency}
            render={(items) => (
              <EventRail
                items={items as PublicEventCard[]}
                label={t('eventsLabel')}
                states={states}
                showCity
              />
            )}
          />
        </div>
      )}
    </BrandPage>
  );
}
