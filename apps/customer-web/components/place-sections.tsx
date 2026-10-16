'use client';

import { useQuery } from '@tanstack/react-query';
import { Compass, MapPin } from 'lucide-react';
import {
  api as webKitApi,
  brandChipClasses,
  BrandButton,
  countryPhrase,
  countryKey,
  useCity,
} from '@eticketsgo/web-kit';
import { Button, EmptyState } from '@/components/ui';
import { BrandEmpty } from './storefront-brand';

/*
  The groups below the selected city: "More in <country>", then one "Elsewhere: <country>" per
  other country. The pages decide how an item looks (a card, a poster); this decides the titles,
  the order and the currency note, so Explore, Browse and Movies cannot drift apart.

  Plain English and ASCII, like the pages that use it; the home page has its own translated
  version of the same groups.
*/

/** At most this many in each group: a taste of what is on, with "See all" as the way further. */
const PER_GROUP = 6;

/** The groups under the selected place; see `usePlaceGroups`. */
export interface PlaceGroupsView<T> {
  sameCountry: T[];
  elsewhere: { code: string; name: string; items: T[] }[];
  /** The selected place's country (ISO code), to title "More in <country>". */
  homeCountry: string | null;
}

export function PlaceSections<T>({
  buckets,
  render,
  currencyOf,
  limit = PER_GROUP,
  level = 2,
  variant = 'legacy',
}: {
  buckets: PlaceGroupsView<T>;
  render: (items: T[]) => React.ReactNode;
  /** What a listing prices in, so a group can say so. Films carry no price: leave it out. */
  currencyOf?: (item: T) => string | undefined;
  limit?: number;
  level?: 2 | 3;
  /**
   * `brand` for a page on the brand layer (Explore, Movies): the display-face section heading
   * and the brand's quiet note. Browse still draws the old system and keeps `legacy`.
   */
  variant?: 'legacy' | 'brand';
}) {
  const Heading = (level === 2 ? 'h2' : 'h3') as 'h2';
  const country = buckets.homeCountry;
  const brand = variant === 'brand';
  const headingClass = brand
    ? 'text-balance font-brand-display text-brand-d2 text-brand-ink'
    : 'text-h3 font-bold tracking-tight text-text-primary';
  const noteClass = brand
    ? 'mt-2 text-brand-meta text-brand-ink-3'
    : 'mt-1 text-[0.9375rem] text-text-muted';
  const sectionClass = brand ? 'space-y-6' : 'space-y-5';
  return (
    <>
      {buckets.sameCountry.length > 0 && (
        <section
          aria-labelledby="place-same-country"
          data-place-group="same-country"
          className={sectionClass}
        >
          <Heading id="place-same-country" className={headingClass}>
            {country ? `More in ${countryPhrase(country)}` : 'More events'}
          </Heading>
          {render(buckets.sameCountry.slice(0, limit))}
        </section>
      )}
      {buckets.elsewhere.map((group) => {
        const currencies = currencyOf
          ? [...new Set(group.items.map(currencyOf).filter(Boolean))]
          : [];
        const id = `place-elsewhere-${group.code.toLowerCase()}`;
        return (
          <section
            key={group.code}
            aria-labelledby={id}
            data-place-group="elsewhere"
            data-country={group.code}
            className={sectionClass}
          >
            <div>
              <Heading id={id} className={headingClass}>
                {`Elsewhere: ${group.name}`}
              </Heading>
              {currencies.length === 1 && (
                <p className={noteClass}>Prices in {currencies[0]}. Times are at the venue.</p>
              )}
            </div>
            {render(group.items.slice(0, limit))}
          </section>
        );
      })}
    </>
  );
}

/**
 * "Nothing here yet", with somewhere to go.
 *
 * Names the selected place, offers the cities in the same country that do have something (the
 * nearest honest suggestion), and the search box. The groups for the rest of the country and
 * the world are drawn under this by `PlaceSections`, so an empty city never reads as an empty
 * platform.
 */
export function EmptyPlace({
  place,
  noun = 'events',
  icon = Compass,
  variant = 'legacy',
}: {
  place: string;
  noun?: string;
  icon?: typeof Compass;
  /** `brand` draws the same words and choices on the brand layer; see `PlaceSections`. */
  variant?: 'legacy' | 'brand';
}) {
  const preference = useCity();
  const country = preference.place?.country ?? preference.country;
  const key = countryKey(country);
  const nearby = useQuery({
    queryKey: ['sellable-cities', key],
    queryFn: () => webKitApi.location.cities({ country: key ?? undefined, limit: 8 }),
    enabled: Boolean(key),
  });
  const suggestions = (nearby.data ?? [])
    .filter((c) => c.eventCount > 0 && c.city.toLowerCase() !== preference.city?.toLowerCase())
    .slice(0, 6);
  const title = `No ${noun} available in ${place} yet`;
  const hint =
    suggestions.length > 0
      ? `These cities in ${key ? countryPhrase(key) : 'your country'} have something on:`
      : 'Search for a city to see what is on there.';
  const choose = (c: (typeof suggestions)[number]) =>
    preference.setCity(c.city, {
      region: c.region ?? null,
      country: c.countryCode ?? c.country,
    });

  if (variant === 'brand') {
    return (
      <BrandEmpty
        title={title}
        hint={hint}
        action={
          <>
            {suggestions.map((c) => (
              <button
                key={`${c.countryCode ?? c.country}-${c.city}`}
                type="button"
                onClick={() => choose(c)}
                className={`${brandChipClasses(false)} h-11`}
              >
                {c.city}
                <span className="tabular-nums text-brand-ink-3">{c.eventCount}</span>
              </button>
            ))}
            <BrandButton variant="secondary" onClick={() => preference.requestPicker()}>
              Search for a city
            </BrandButton>
          </>
        }
      />
    );
  }

  return (
    <EmptyState
      title={title}
      hint={hint}
      icon={icon}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {suggestions.map((c) => (
            <Button
              key={`${c.countryCode ?? c.country}-${c.city}`}
              variant="outline"
              onClick={() => choose(c)}
            >
              <MapPin className="h-4 w-4" aria-hidden="true" />
              {c.city}
              <span className="text-text-muted">{c.eventCount}</span>
            </Button>
          ))}
          <Button variant="secondary" onClick={() => preference.requestPicker()}>
            Search for a city
          </Button>
        </div>
      }
    />
  );
}
