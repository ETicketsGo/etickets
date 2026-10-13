'use client';

import { useQuery } from '@tanstack/react-query';
import { Compass, MapPin } from 'lucide-react';
import { api as webKitApi, countryPhrase, countryKey, useCity } from '@eticketsgo/web-kit';
import { Button, EmptyState } from '@/components/ui';

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
}: {
  buckets: PlaceGroupsView<T>;
  render: (items: T[]) => React.ReactNode;
  /** What a listing prices in, so a group can say so. Films carry no price: leave it out. */
  currencyOf?: (item: T) => string | undefined;
  limit?: number;
  level?: 2 | 3;
}) {
  const Heading = (level === 2 ? 'h2' : 'h3') as 'h2';
  const country = buckets.homeCountry;
  return (
    <>
      {buckets.sameCountry.length > 0 && (
        <section
          aria-labelledby="place-same-country"
          data-place-group="same-country"
          className="space-y-5"
        >
          <Heading
            id="place-same-country"
            className="text-h3 font-bold tracking-tight text-text-primary"
          >
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
            className="space-y-5"
          >
            <div>
              <Heading id={id} className="text-h3 font-bold tracking-tight text-text-primary">
                {`Elsewhere: ${group.name}`}
              </Heading>
              {currencies.length === 1 && (
                <p className="mt-1 text-[0.9375rem] text-text-muted">
                  Prices in {currencies[0]}. Times are at the venue.
                </p>
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
}: {
  place: string;
  noun?: string;
  icon?: typeof Compass;
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

  return (
    <EmptyState
      title={`No ${noun} available in ${place} yet`}
      hint={
        suggestions.length > 0
          ? `These cities in ${key ? countryPhrase(key) : 'your country'} have something on:`
          : 'Search for a city to see what is on there.'
      }
      icon={icon}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {suggestions.map((c) => (
            <Button
              key={`${c.countryCode ?? c.country}-${c.city}`}
              variant="outline"
              onClick={() =>
                preference.setCity(c.city, {
                  region: c.region ?? null,
                  country: c.countryCode ?? c.country,
                })
              }
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
