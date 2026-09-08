import { afterEach, describe, expect, it } from 'vitest';
import { visitorCountry, visitorCountryFromTimeZone } from './locale';

/**
 * Where we think a visitor is, when their browser will not say.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────────────
 * The country hint came only from `navigator.language`. A browser reporting a bare `en` —
 * which many do — gave no region, so the hint was null, so discovery could not scope to a
 * country and offered cities from everywhere. A visitor in the United States opened the city
 * picker and was shown Bengaluru, Hyderabad and Mumbai above the one city near them.
 *
 * Nothing errored, and from the outside it read as a broken control rather than as a missing
 * signal, which is why it survived: the code was doing exactly what it was written to do.
 */

const realDateTimeFormat = Intl.DateTimeFormat;

function withTimeZone(zone: string | undefined, run: () => void) {
  // Only `resolvedOptions().timeZone` is being stubbed; everything else defers to the real
  // implementation, so a formatting call inside the code under test still behaves.
  Intl.DateTimeFormat = ((...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
    const real = new realDateTimeFormat(...args);
    return {
      ...real,
      resolvedOptions: () => ({ ...real.resolvedOptions(), timeZone: zone as string }),
    };
  }) as unknown as typeof Intl.DateTimeFormat;
  try {
    run();
  } finally {
    Intl.DateTimeFormat = realDateTimeFormat;
  }
}

describe('visitorCountryFromTimeZone', () => {
  it.each([
    ['America/Chicago', 'US'],
    ['America/New_York', 'US'],
    ['America/Toronto', 'CA'],
    ['Asia/Kolkata', 'IN'],
    ['Asia/Dubai', 'AE'],
  ])('%s resolves to %s', (zone, expected) => {
    withTimeZone(zone, () => {
      expect(visitorCountryFromTimeZone()).toBe(expected);
    });
  });

  it('returns null for a country the platform does not sell in', () => {
    /*
      Null rather than the country, so the caller falls through to its next signal. Scoping
      the storefront to a market with nothing on sale shows an empty page, and an empty page
      reads as a dead company rather than as a wrong guess.
    */
    withTimeZone('Europe/Berlin', () => {
      expect(visitorCountryFromTimeZone()).toBeNull();
    });
  });

  it('returns null rather than throwing when no zone can be resolved', () => {
    withTimeZone(undefined, () => {
      expect(visitorCountryFromTimeZone()).toBeNull();
    });
  });
});

describe('visitorCountry', () => {
  const realNavigator = globalThis.navigator;
  const setLanguages = (languages: string[]) => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { languages, language: languages[0] },
      configurable: true,
    });
  };
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: realNavigator,
      configurable: true,
    });
  });

  it('answers from the time zone when the language carries no region', () => {
    // The whole point. `en` has no region, and this is precisely the visitor who was being
    // shown the wrong cities.
    setLanguages(['en']);
    withTimeZone('America/Chicago', () => {
      expect(visitorCountry()).toBe('US');
    });
  });

  it('prefers the time zone over the language when they disagree', () => {
    /*
      A US-English browser in Toronto is the example the module's own comment gives for why
      the locale is a weak signal. The operating system's zone is set by where the machine
      is; the language is set by what the person reads.
    */
    setLanguages(['en-US']);
    withTimeZone('America/Toronto', () => {
      expect(visitorCountry()).toBe('CA');
    });
  });

  it('still falls back to the language for a zone we do not sell in', () => {
    setLanguages(['en-GB']);
    withTimeZone('Europe/Berlin', () => {
      expect(visitorCountry()).toBe('GB');
    });
  });

  it('is null when neither signal says anything', () => {
    setLanguages(['en']);
    withTimeZone('Europe/Berlin', () => {
      expect(visitorCountry()).toBeNull();
    });
  });
});
