'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import {
  api as webKitApi,
  brandChipClasses,
  BrandButton,
  countryKey,
  useCity,
} from '@eticketsgo/web-kit';
import { useCountryWords } from '@/lib/country-words';
import { BrandEmpty } from './storefront-brand';

/*
  The groups below the selected city: "More in <country>", then one "Elsewhere: <country>" per
  other country. The pages decide how an item looks (a card, a poster); this decides the titles,
  the order and the currency note, so Explore, Browse and Movies cannot drift apart.

  Every word comes from the `storefront.placeGroups` messages, so a French visitor reads these
  groups in French on Explore, Browse and Movies alike. The home page has its own version of the
  same groups under `home.sections`.

  Drawn on the brand layer only. There was an old-system `legacy` variant beside `brand`; Explore,
  Browse and Movies all pass through here on the brand layer now, so it had no caller and went.
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
  const t = useTranslations('storefront.placeGroups');
  const english = useLocale().startsWith('en');
  const words = useCountryWords();
  const Heading = (level === 2 ? 'h2' : 'h3') as 'h2';
  const country = buckets.homeCountry;
  const headingClass = 'text-balance font-brand-display text-brand-d2 text-brand-ink';
  const noteClass = 'mt-2 text-brand-meta text-brand-ink-3';
  const sectionClass = 'space-y-6';
  return (
    <>
      {buckets.sameCountry.length > 0 && (
        <section
          aria-labelledby="place-same-country"
          data-place-group="same-country"
          className={sectionClass}
        >
          <Heading id="place-same-country" className={headingClass}>
            {country ? t('moreIn', { country: words(country, true) }) : t('moreEvents')}
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
                {t('elsewhere', {
                  // English keeps the group's own name; another language names the ISO code.
                  country:
                    english || !/^[A-Z]{2}$/.test(group.code) ? group.name : words(group.code),
                })}
              </Heading>
              {currencies.length === 1 && (
                <p className={noteClass}>{t('pricesNote', { currency: currencies[0] ?? '' })}</p>
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
}: {
  place: string;
  noun?: 'events' | 'films';
}) {
  const t = useTranslations('storefront.placeGroups');
  const words = useCountryWords();
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
  const title = t(noun === 'films' ? 'noneFilms' : 'noneEvents', { place });
  const hint =
    suggestions.length > 0
      ? key
        ? t('citiesIn', { country: words(key, true) })
        : t('citiesInYours')
      : t('searchHint');
  const choose = (c: (typeof suggestions)[number]) =>
    preference.setCity(c.city, {
      region: c.region ?? null,
      country: c.countryCode ?? c.country,
    });

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
            {t('searchCity')}
          </BrandButton>
        </>
      }
    />
  );
}
