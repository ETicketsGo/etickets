'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  BRAND_FOCUS,
  BrandButton,
  api as webKitApi,
  brandButtonClasses,
  brandChipClasses,
  cityScope,
  countryName,
  countryPhrase,
  inCityScope,
  useCity,
} from '@eticketsgo/web-kit';
import { MARKETS, countryMatches } from '@eticketsgo/shared-types';
import { api } from '@/lib/api';
import {
  buyability,
  chooseHero,
  hasPhoto,
  heroCandidates,
  outsideGroups,
  photosFirst,
  postersFirst,
  type Buyability,
} from '@/lib/home-feed';
import { Link } from '@/i18n/navigation';
import { useRecentlyViewed } from '@/lib/use-live-events';
import {
  EventRow,
  EventTile,
  FeatureCard,
  Placeholder,
  PosterCard,
  Rail,
  RailItem,
  SectionHead,
  StageHero,
  sectionLinkClasses,
} from '@/components/home/parts';

/*
  ── THE FRONT DOOR IS A STAGE (docs/design/DESIGN-SYSTEM.md; EXPERIENCE-AUDIT.md C1, C2, C5) ──
  What it replaced: a white box with a sparkle badge, "Find your next experience", a search field
  and six chips, then uniform grids of pastel cards. On a phone the whole first screen was that
  box: no event, no date, no price (C2). It could have been any product (C5).

  What it is now, top to bottom:
    1. A stage hero made of ONE real event in the visitor's scope: its photo under a scrim, the
       title, venue date and time, venue, organizer, "Book tickets" and the From price. The only
       primary action on the page.
    2. Day and kind chips that filter the section under them in place.
    3. An editorial section for the city: a 16:9 feature beside a 4:3 list.
    4. "Now showing": a 2:3 poster rail on a stage band.
    5. Events OUTSIDE the visitor's city, in their own titled group with the city on every card
       and the currency code beside every price (audit C3: a buyer must be able to tell what
       "near me" means and what they will be charged).
    6. Recently viewed, the promises a buyer needs before paying, and the organizer path.

  Nothing here is invented: every figure is a field the public API already returns, every
  price is in the event's own currency, and no event is picked by hand. "Featured" is the API's
  own order (newest listed first) with listings that have a photo ahead of those without, so
  the front door does not lead with a blank.
*/

type ChipKey = 'concerts' | 'comedy' | 'sports' | 'workshops' | 'theatre';

/**
 * The kinds of event offered as chips, and the category names each one covers.
 *
 * A chip appears only when `/public/categories` reports at least one of its names: a chip that
 * can only lead to an empty page reads as "nothing on" (the lesson the old hardcoded list
 * taught, when three of five chips were guaranteed empty). The API matches a category exactly
 * (case aside), so when a kind is stored under two spellings the chip asks for the busier one.
 */
const KIND_CHIPS: { key: ChipKey; names: string[] }[] = [
  { key: 'concerts', names: ['music', 'concert', 'concerts'] },
  { key: 'comedy', names: ['comedy'] },
  { key: 'sports', names: ['sports', 'sport'] },
  { key: 'workshops', names: ['workshop', 'workshops'] },
  { key: 'theatre', names: ['theatre', 'theater'] },
];

type Filter =
  | { kind: 'all' }
  | { kind: 'today' }
  | { kind: 'weekend' }
  | { kind: 'category'; chip: ChipKey; category: string };

/** Now until the end of today, on the visitor's clock. */
function todayRange(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 0);
  return { dateFrom: now.toISOString(), dateTo: end.toISOString() };
}

/** This weekend: the coming Saturday 00:00 to Sunday 23:59, on the visitor's clock. */
function weekendRange(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const daysToSat = (6 - now.getDay() + 7) % 7;
  const sat = new Date(now);
  sat.setDate(now.getDate() + daysToSat);
  sat.setHours(0, 0, 0, 0);
  const sun = new Date(sat);
  sun.setDate(sat.getDate() + 1);
  sun.setHours(23, 59, 59, 0);
  return { dateFrom: sat.toISOString(), dateTo: sun.toISOString() };
}

/** The page's side gutters, matching the header's (DESIGN-SYSTEM.md section 3). */
const WRAP = 'mx-auto max-w-shell px-4 sm:px-6 lg:px-10';

export function DiscoverHome() {
  const t = useTranslations('home');
  const locale = useLocale();
  const preference = useCity();
  const scope = cityScope(preference);
  const scopeKey = JSON.stringify(scope);
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });

  /*
    The place as words. English reads it inside a sentence ("Coming up in the United States");
    the French strings put it after a colon, where the bare name is correct.
  */
  const whereCountry = preference.city ? null : preference.country;
  const place =
    preference.city ??
    (whereCountry
      ? locale.startsWith('en')
        ? countryPhrase(whereCountry)
        : countryName(whereCountry)
      : null);

  // Everything on in scope: the hero, and the section under the chips when nothing is chosen.
  const scoped = useQuery({
    queryKey: ['events', 'home', scopeKey],
    queryFn: () => api.listEvents({ pageSize: '24', ...scope }),
  });

  const filterParams = useMemo((): Record<string, string> => {
    if (filter.kind === 'today') return todayRange();
    if (filter.kind === 'weekend') return weekendRange();
    if (filter.kind === 'category') return { category: filter.category };
    return {};
    // The ranges are recomputed when the chip is pressed, which is when they should be.
  }, [filter]);
  const filtered = useQuery({
    queryKey: ['events', 'home', scopeKey, filterParams],
    queryFn: () => api.listEvents({ pageSize: '24', ...scope, ...filterParams }),
    enabled: filter.kind !== 'all',
  });

  const categories = useQuery({
    queryKey: ['public-categories'],
    queryFn: () => api.publicCategories(),
  });
  const kindChips = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const c of categories.data ?? []) {
      const key = c.category.trim().toLowerCase();
      const seen = counts.get(key);
      if (!seen || c.count > seen.count)
        counts.set(key, { name: c.category.trim(), count: c.count });
    }
    return KIND_CHIPS.flatMap((chip) => {
      const best = chip.names
        .map((n) => counts.get(n))
        .filter((c): c is { name: string; count: number } => Boolean(c))
        .sort((a, b) => b.count - a.count)[0];
      return best ? [{ key: chip.key, category: best.name }] : [];
    });
  }, [categories.data]);

  const movies = useQuery({
    queryKey: ['movies', 'home', scopeKey],
    queryFn: () =>
      api.listMovies(
        preference.city
          ? { city: preference.city }
          : preference.country
            ? { country: preference.country }
            : undefined,
      ),
  });
  const films = postersFirst(movies.data ?? []).slice(0, 5);

  // Events elsewhere, asked for only when there is a "here" to be outside of.
  const outsideScope = Boolean(preference.city || preference.country);
  const everywhere = useQuery({
    queryKey: ['events', 'home', 'everywhere'],
    queryFn: () => api.listEvents({ pageSize: '100' }),
    enabled: outsideScope,
  });
  /*
    Elsewhere, in groups of one currency each (see `outsideGroups`): the visitor's own currency
    first, then other markets, each titled with where it is and what it prices in. Nearest
    first inside a group: the visitor's own country, then listings with a photo.
  */
  const homeCountry = preference.place?.country ?? preference.country;
  const homeCurrency =
    scoped.data?.data[0]?.currency ??
    MARKETS.find((m) => homeCountry && countryMatches(m.code, homeCountry))?.currency ??
    null;
  const outside = useMemo(
    () =>
      outsideGroups(
        (everywhere.data?.data ?? []).filter((e) => !inCityScope(e, preference)),
        { currency: homeCurrency, country: homeCountry },
      ),
    [everywhere.data, preference, homeCountry, homeCurrency],
  );
  /** "US Dollar", in the reader's language, for a group's "Prices in" line. */
  const currencyName = (code: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'currency' }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const countryLabel = (country: string) => {
    const code = country.trim().length === 2 ? country.trim().toUpperCase() : null;
    if (!code) return country;
    return locale.startsWith('en') ? countryPhrase(code) : countryName(code);
  };

  const { events: recent } = useRecentlyViewed(preference);

  /*
    Cities we actually sell in, asked for ONLY when the place we are showing has nothing, so
    the empty front door names places with something on instead of an empty picker.
  */
  const nothingHere = scoped.isSuccess && scoped.data.data.length === 0;
  const sellableCities = useQuery({
    queryKey: ['public-sellable-cities'],
    queryFn: () => webKitApi.location.cities({ limit: 6 }),
    enabled: nothingHere && preference.topCities.length === 0,
  });
  const suggestedCities = (
    preference.topCities.length > 0 ? preference.topCities : (sellableCities.data ?? [])
  ).slice(0, 6);

  const all = photosFirst(scoped.data?.data ?? []);
  /*
    Whether the events this page promotes can be bought right now. The listing payload has no
    availability or sales window, so the few events the page features or lists first are read
    from `/public/events/:slug` (the same query, and cache, as the event page itself). Bounded:
    6 hero candidates, 9 listed, 12 in the rails and 4 recent - at most 31 small reads, cached
    for a minute; nothing else on the page waits for them, and a card shows its price only once
    its own read proves something is on sale.
  */
  const filteredAll = photosFirst(filtered.data?.data ?? []);
  const checkSlugs = [
    ...new Set([
      ...heroCandidates(all),
      ...all.slice(0, 9).map((e) => e.slug),
      ...(filter.kind === 'all' ? [] : filteredAll.slice(0, 9).map((e) => e.slug)),
      // The rails below: at most 3 groups of 4, and 4 recently viewed.
      ...outside.flatMap((g) => g.items.map((e) => e.slug)),
      ...recent.slice(0, 4).map((e) => e.slug),
    ]),
  ];
  const details = useQueries({
    queries: checkSlugs.map((slug) => ({
      queryKey: ['event', slug],
      queryFn: () => api.getEvent(slug),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const states = new Map<string, Buyability | undefined>(
    checkSlugs.map((slug, i) => {
      const q = details[i];
      // A listing whose page will not open (unpublished since) cannot be bought either.
      return [slug, q.data ? buyability(q.data) : q.isError ? 'CLOSED' : undefined];
    }),
  );
  /*
    The hero needs a photo AND a ticket you can buy now (see `chooseHero`): a review caught a
    sold-out show as the Bengaluru hero, "Book tickets" over a house with no seats left.
    Without one, the stage steps down to a compact band naming the place and the count - the
    same as for a city whose organizers uploaded no art, where a title-only hero once set
    "Free Talk 1791849580330" in 80px type as the face of the page.
  */
  const { hero, pending: heroPending } = chooseHero(all, states);
  /*
    What can still be bought leads the section; a sold-out or closed listing stays, labelled,
    at the end rather than becoming the 16:9 feature (sort is stable, so the rest keep order).
  */
  const unbuyable = (e: { slug: string }) => {
    const st = states.get(e.slug);
    return st === 'SOLD_OUT' || st === 'CLOSED' ? 1 : 0;
  };
  const lead = (filter.kind === 'all' ? all.filter((e) => e.id !== hero?.id) : filteredAll).sort(
    (a, b) => unbuyable(a) - unbuyable(b),
  );
  const leadLoading = filter.kind === 'all' ? scoped.isLoading : filtered.isLoading;
  const leadTotal =
    filter.kind === 'all' ? (scoped.data?.meta.total ?? 0) : (filtered.data?.meta.total ?? 0);

  const kindLabel = filter.kind === 'category' ? t(`chips.${filter.chip}`) : null;
  const leadTitle = (() => {
    if (filter.kind === 'today')
      return place ? t('sections.todayIn', { place }) : t('sections.today');
    if (filter.kind === 'weekend')
      return place ? t('sections.weekendIn', { place }) : t('sections.weekend');
    if (kindLabel) return place ? t('sections.kindIn', { kind: kindLabel, place }) : kindLabel;
    return place ? t('sections.upcomingIn', { place }) : t('sections.upcoming');
  })();

  /** Browse, scoped and filtered the way this section is, for "See all". */
  const seeAllHref = (() => {
    const params = new URLSearchParams();
    if (preference.city) params.set('city', preference.city);
    for (const [k, v] of Object.entries(filterParams)) params.set(k, v);
    const q = params.toString();
    return q ? `/events?${q}` : '/events';
  })();

  const chip = (selected: boolean) => `${brandChipClasses(selected)} h-11 shrink-0 lg:h-9`;

  return (
    <div data-brand="customer" className="bg-brand-canvas font-brand-text text-brand-ink">
      <h1 className="sr-only">{place ? t('page.title', { place }) : t('page.titleAnywhere')}</h1>

      {/* 1. The stage. */}
      {scoped.isLoading || heroPending ? (
        <div data-brand-tone="stage" className="bg-brand-canvas">
          <div
            className={`${WRAP} flex min-h-[520px] flex-col justify-end pb-8 lg:min-h-[600px] lg:pb-16`}
          >
            <Placeholder className="h-4 w-40" />
            <Placeholder className="mt-4 h-20 w-full max-w-xl" />
            <Placeholder className="mt-6 h-12 w-48" />
          </div>
        </div>
      ) : scoped.isError ? (
        <section data-brand-tone="stage" className="bg-brand-canvas">
          <div className={`${WRAP} py-16 lg:py-24`}>
            <p className="max-w-prose text-brand-lead text-brand-ink">{t('empty.loadFailed')}</p>
            <BrandButton className="mt-6" onClick={() => void scoped.refetch()}>
              {t('empty.retry')}
            </BrandButton>
          </div>
        </section>
      ) : hero ? (
        <StageHero event={hero} />
      ) : all.length > 0 ? (
        <section data-brand-tone="stage" className="bg-brand-canvas">
          <div className={`${WRAP} py-12 lg:py-16`}>
            <p className="text-brand-eyebrow uppercase text-brand-ink-2">
              {t('page.countOnSale', { count: scoped.data?.meta.total ?? all.length })}
            </p>
            <h2 className="mt-3 max-w-3xl text-balance font-brand-display text-brand-d1 text-brand-ink">
              {place ? t('page.title', { place }) : t('page.titleAnywhere')}
            </h2>
            <span aria-hidden className="mt-6 block h-1 w-10 rounded-full bg-brand-marigold" />
          </div>
        </section>
      ) : (
        /*
          Empty because of WHERE, and it says so - on the stage, where the hero would be.

          "No events yet" on a page quietly narrowed to one city is the most misleading thing
          this product can say: the visitor concludes the platform is dead when there are
          events one city over. So the way out is right here: the cities that have something
          on (real cities with a count, the same action as typing one), and the picker.
        */
        <section data-brand-tone="stage" className="bg-brand-canvas">
          <div className={`${WRAP} py-16 lg:py-24`}>
            <h2 className="max-w-3xl text-balance font-brand-display text-brand-d1 text-brand-ink">
              {place ? t('empty.noneIn', { place }) : t('empty.none')}
            </h2>
            <p className="mt-4 max-w-prose text-brand-lead text-brand-ink-2">
              {!place
                ? t('empty.noneHint')
                : whereCountry
                  ? t('empty.sellingHere')
                  : t('empty.otherPlaces')}
            </p>
            {place && (
              <div className="mt-8 flex flex-wrap items-center gap-3">
                {whereCountry ? (
                  <>
                    {suggestedCities.map((c) => (
                      <button
                        key={`${c.country}-${c.city}`}
                        type="button"
                        onClick={() =>
                          preference.setCity(c.city, {
                            region: c.region ?? null,
                            country: c.country,
                          })
                        }
                        className={chip(false)}
                      >
                        {c.city}
                        <span className="tabular-nums text-brand-ink-3">{c.eventCount}</span>
                      </button>
                    ))}
                    <BrandButton variant="quiet" onClick={() => preference.requestPicker()}>
                      {t('empty.searchCity')}
                    </BrandButton>
                  </>
                ) : (
                  <BrandButton variant="secondary" onClick={() => preference.setCity(null)}>
                    {t('empty.everywhere')}
                  </BrandButton>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 2 and 3. The chips, and the section they filter. */}
      {!nothingHere && !scoped.isError && (
        <section aria-labelledby="home-lead" className={`${WRAP} pt-6 lg:pt-8`}>
          <div
            role="group"
            aria-label={t('chips.label')}
            className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0"
          >
            <button
              type="button"
              aria-pressed={filter.kind === 'all'}
              onClick={() => setFilter({ kind: 'all' })}
              className={chip(filter.kind === 'all')}
            >
              {t('chips.all')}
            </button>
            <button
              type="button"
              aria-pressed={filter.kind === 'today'}
              onClick={() => setFilter({ kind: 'today' })}
              className={chip(filter.kind === 'today')}
            >
              {t('chips.today')}
            </button>
            <button
              type="button"
              aria-pressed={filter.kind === 'weekend'}
              onClick={() => setFilter({ kind: 'weekend' })}
              className={chip(filter.kind === 'weekend')}
            >
              {t('chips.weekend')}
            </button>
            {/* Films have their own page with showtimes; this chip goes there. */}
            {films.length > 0 && (
              <Link href="/movies" className={chip(false)}>
                {t('chips.movies')}
              </Link>
            )}
            {kindChips.map((k) => {
              const on = filter.kind === 'category' && filter.chip === k.key;
              return (
                <button
                  key={k.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setFilter(
                      on
                        ? { kind: 'all' }
                        : { kind: 'category', chip: k.key, category: k.category },
                    )
                  }
                  className={chip(on)}
                >
                  {t(`chips.${k.key}`)}
                </button>
              );
            })}
          </div>

          {/*
            With "All" chosen and the hero the only event in scope, the section would be a heading
            over nothing; the hero already IS what is on.
          */}
          {(filter.kind !== 'all' || leadLoading || lead.length > 0) && (
            <div className="pt-10 lg:pt-12">
              <SectionHead
                id="home-lead"
                title={leadTitle}
                action={
                  leadTotal > 0 ? (
                    <Link href={seeAllHref} className={sectionLinkClasses()}>
                      {t('sections.seeAll', { count: leadTotal })}
                    </Link>
                  ) : undefined
                }
              />
              {leadLoading ? (
                <div className="grid gap-8 lg:grid-cols-[7fr_5fr]">
                  <Placeholder className="aspect-video w-full" />
                  <div className="space-y-4">
                    <Placeholder className="h-20 w-full" />
                    <Placeholder className="h-20 w-full" />
                    <Placeholder className="h-20 w-full" />
                  </div>
                </div>
              ) : lead.length === 0 ? (
                filter.kind === 'all' ? null : (
                  // A filter that found nothing says so, and offers the way back in one press.
                  <div className="rounded-brand-card bg-brand-sunken px-6 py-10 text-center">
                    <p className="font-brand-display text-brand-d3 text-brand-ink">
                      {place ? t('empty.noMatch', { place }) : t('empty.noMatchAnywhere')}
                    </p>
                    <p className="mt-2 text-brand-ui text-brand-ink-2">{t('empty.noMatchHint')}</p>
                    <BrandButton
                      variant="secondary"
                      className="mt-6"
                      onClick={() => setFilter({ kind: 'all' })}
                    >
                      {t('empty.clear')}
                    </BrandButton>
                  </div>
                )
              ) : !hasPhoto(lead[0]) ? (
                /*
                  No photo to lead with: a 16:9 block of title-on-black above the same title
                  read as a broken picture. Rows, two columns from lg, say the same with less.
                */
                <ul className="grid gap-x-10 divide-y divide-brand-line lg:grid-cols-2 lg:divide-y-0">
                  {lead.slice(0, 8).map((e) => (
                    <li key={e.id} className="lg:border-b lg:border-brand-line">
                      <EventRow event={e} state={states.get(e.slug)} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="grid gap-8 lg:grid-cols-[7fr_5fr] lg:gap-10">
                  <FeatureCard event={lead[0]} state={states.get(lead[0].slug)} />
                  {lead.length > 1 && (
                    <ul className="divide-y divide-brand-line lg:-mt-4">
                      {lead.slice(1, 5).map((e) => (
                        <li key={e.id}>
                          <EventRow event={e} state={states.get(e.slug)} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* 4. Now showing, on a stage band. */}
      {films.length > 0 && (
        <section
          data-brand-tone="stage"
          aria-labelledby="home-films"
          className="mt-12 bg-brand-canvas py-12 lg:mt-16 lg:py-16"
        >
          <div className={WRAP}>
            <SectionHead
              id="home-films"
              title={t('sections.nowShowing')}
              action={
                <Link href="/movies" className={sectionLinkClasses()}>
                  {preference.city
                    ? t('sections.allFilmsIn', { place: preference.city })
                    : t('sections.allFilms')}
                </Link>
              }
            />
            <Rail cols={5} phone="poster" label={t('sections.nowShowing')}>
              {films.map((m) => (
                <RailItem key={m.id}>
                  <PosterCard movie={m} />
                </RailItem>
              ))}
            </Rail>
          </div>
        </section>
      )}

      {/*
        5. Elsewhere, one currency per group. The first group is the visitor's own currency
        ("Outside Bengaluru"); others are titled by country ("In Canada") and every group says
        which currency its prices are in, so no rail mixes Rs, $ and CA$.
      */}
      {outsideScope &&
        outside.map((group, index) => {
          const same = group.currency === homeCurrency;
          const title =
            same && place
              ? t('sections.outside', { place })
              : same
                ? t('sections.elsewhere')
                : t('sections.inCountry', { country: countryLabel(group.country) });
          const id = `home-outside-${group.currency.toLowerCase()}`;
          return (
            <section
              key={group.currency}
              aria-labelledby={id}
              data-currency={group.currency}
              className={`${WRAP} pt-12 lg:pt-16`}
            >
              <SectionHead
                id={id}
                title={title}
                hint={t('sections.pricesIn', {
                  name: currencyName(group.currency),
                  currency: group.currency,
                })}
                action={
                  index === 0 ? (
                    <button
                      type="button"
                      onClick={() => preference.requestPicker()}
                      className={sectionLinkClasses()}
                    >
                      {t('sections.changeCity')}
                    </button>
                  ) : undefined
                }
              />
              <Rail cols={4} label={title}>
                {group.items.map((e) => (
                  <RailItem key={e.id}>
                    <EventTile event={e} showCity state={states.get(e.slug)} />
                  </RailItem>
                ))}
              </Rail>
            </section>
          );
        })}

      {/*
        6. Recently viewed: current, still on sale, and scoped like everything else here (see
        `useRecentlyViewed` - it was once the one list nothing filtered or kept up to date).
      */}
      {recent.length > 0 && (
        <section aria-labelledby="home-recent" className={`${WRAP} pt-12 lg:pt-16`}>
          <SectionHead id="home-recent" title={t('sections.recent')} />
          <Rail cols={4} label={t('sections.recent')}>
            {recent.slice(0, 4).map((e) => (
              <RailItem key={e.id}>
                <EventTile event={e} state={states.get(e.slug)} />
              </RailItem>
            ))}
          </Rail>
        </section>
      )}

      {/*
        What a buyer needs to know before paying a stranger on the internet - three promises the
        product already keeps - and the organizer path, kept and demoted. Quiet on purpose: type
        and hairlines, no icon tiles.
      */}
      <section aria-labelledby="home-trust" className={`${WRAP} pb-16 pt-16 lg:pb-24 lg:pt-24`}>
        <h2 id="home-trust" className="text-brand-eyebrow uppercase text-brand-ink-3">
          {t('trust.title')}
        </h2>
        <div className="mt-6 grid gap-8 border-t border-brand-line pt-8 sm:grid-cols-3">
          {(['fees', 'offline', 'refund'] as const).map((k) => (
            <div key={k}>
              <h3 className="font-brand-display text-brand-card text-brand-ink">
                {t(`trust.${k}Title`)}
              </h3>
              <p className="mt-2 max-w-prose text-brand-ui text-brand-ink-2">
                {t(`trust.${k}Body`)}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-x-6">
          {(
            [
              ['/refunds', 'refundPolicy'],
              ['/terms', 'terms'],
              ['/privacy', 'privacy'],
              ['/contact', 'contact'],
            ] as const
          ).map(([href, key]) => (
            <Link
              key={href}
              href={href}
              className={`inline-flex min-h-11 items-center text-brand-ui text-brand-ink underline decoration-brand-line-strong underline-offset-4 hover:decoration-brand-ink ${BRAND_FOCUS}`}
            >
              {t(`trust.${key}`)}
            </Link>
          ))}
        </div>

        {/*
          The organizer path. It points at `/organizers`, the page that explains what we offer,
          never at a console a stranger has no account for.
        */}
        <div className="mt-16 flex flex-col items-start justify-between gap-6 rounded-brand-card border border-brand-line bg-brand-surface p-6 sm:flex-row sm:items-center lg:p-8">
          <div>
            <h2 className="font-brand-display text-brand-d3 text-brand-ink">
              {t('organizers.title')}
            </h2>
            <p className="mt-2 max-w-prose text-brand-ui text-brand-ink-2">
              {t('organizers.body')}
            </p>
          </div>
          <Link href="/organizers" className={brandButtonClasses('secondary', 'md')}>
            {t('organizers.cta')}
          </Link>
        </div>
      </section>
    </div>
  );
}
