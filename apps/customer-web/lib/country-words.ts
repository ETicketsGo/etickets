'use client';

import { useLocale } from 'next-intl';
import { countryName, countryPhrase } from '@eticketsgo/web-kit';

/**
 * A country as words, in the reader's language.
 *
 * English keeps the market names the rest of the storefront prints, with the article when the
 * name sits inside a sentence ("More in the United States"). Every other language gets the
 * name from `Intl.DisplayNames` ("États-Unis"), and its strings put the name after a colon,
 * where the bare name is correct - so no French sentence has to agree with "au", "aux" or "en".
 *
 * `value` is an ISO alpha-2 code or, for a country that is not one of our markets, the name as
 * stored; a stored name is shown as it came, in every language.
 */
export function useCountryWords(): (value: string, inSentence?: boolean) => string {
  const locale = useLocale();
  const english = locale.startsWith('en');
  return (value, inSentence = false) => {
    // English exactly as before this hook existed: the market helpers, whatever shape it came in.
    if (english) return inSentence ? countryPhrase(value) : countryName(value);
    const code = /^[A-Za-z]{2}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
    if (!code) return value;
    try {
      return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? countryName(code);
    } catch {
      return countryName(code);
    }
  };
}
