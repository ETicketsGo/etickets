'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
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
  The empty state for a place with nothing on, shared by Explore, Browse and Movies.

  There used to be `PlaceSections` here too: "More in <country>", then one "Elsewhere: <country>"
  rail per other country, under every listing. The owner removed them (2026-10-19, "do we really
  need Elsewhere part?"): a page shows the place the visitor chose and nothing from somewhere
  else. "All cities" is one list of the visitor's country, a city is that city alone, and an
  empty city says so and offers the cities in its country and the search - no rails of other
  countries' events under it. Every word comes from the `storefront.placeGroups` messages.
*/

/**
 * "Nothing here yet", with somewhere to go.
 *
 * Names the selected place, offers the cities in the same country that do have something (the
 * nearest honest suggestion), and the search box. Nothing from other countries is drawn under
 * it: the way out is choosing a city, never a list of somewhere else.
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
