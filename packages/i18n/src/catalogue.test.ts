import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, MESSAGES, format, resolveLocale, t } from './index';

/**
 * The catalogue cannot be half-translated, and this is what makes that true.
 *
 * ── WHY A TEST AND NOT A REVIEW ────────────────────────────────────────────────────
 * Quebec's Charter of the French Language does not accept "mostly French". A storefront in
 * French with an English receipt, or a French checkout whose error messages fall back to
 * English the one time somebody sees them, is not partial compliance — it is the same
 * exposure as no French at all, plus the cost of having built it.
 *
 * A missing key is invisible in review: the fallback in `lookup` quietly serves English and
 * the page looks finished. So the build fails instead. Adding an English string without its
 * French counterpart is a broken build, in the same way a type error is.
 *
 * The reverse is checked too. A French key with no English source is usually a typo in a
 * path, and it will silently never render.
 */

/** Every dotted leaf path in a message tree, e.g. `event.left`. */
function paths(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    paths(v, prefix ? `${prefix}.${k}` : k),
  );
}

const NAMESPACES = Object.keys(MESSAGES[DEFAULT_LOCALE]) as (keyof (typeof MESSAGES)['en'])[];
const OTHER_LOCALES = LOCALES.filter((l) => l !== DEFAULT_LOCALE);

describe('every locale carries every message', () => {
  describe.each(OTHER_LOCALES)('%s', (locale) => {
    it.each(NAMESPACES)('%s has no missing keys', (ns) => {
      const source = paths(MESSAGES[DEFAULT_LOCALE][ns]).sort();
      const target = paths(MESSAGES[locale][ns]).sort();
      const missing = source.filter((p) => !target.includes(p));
      expect(
        missing,
        `${locale}/${ns}.json is missing ${missing.length} key(s):\n  ${missing.join('\n  ')}\n` +
          `Add them. A missing key falls back to English at runtime, which is exactly the ` +
          `half-translated state this test exists to prevent.`,
      ).toEqual([]);
    });

    it.each(NAMESPACES)('%s has no orphan keys', (ns) => {
      const source = paths(MESSAGES[DEFAULT_LOCALE][ns]).sort();
      const target = paths(MESSAGES[locale][ns]).sort();
      const orphans = target.filter((p) => !source.includes(p));
      expect(
        orphans,
        `${locale}/${ns}.json has ${orphans.length} key(s) with no English source:\n  ${orphans.join('\n  ')}\n` +
          `Usually a typo in a path — a key nothing looks up will never render.`,
      ).toEqual([]);
    });
  });
});

describe('placeholders match between locales', () => {
  /*
    A translation that drops `{reference}` renders a sentence with a hole in it, and one that
    invents `{refrence}` renders the brace literally. Both read as finished French to anybody
    who is not comparing them side by side with the English, which is nobody.
  */
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();

  it.each(OTHER_LOCALES)('%s', (locale) => {
    const problems: string[] = [];
    for (const ns of NAMESPACES) {
      for (const path of paths(MESSAGES[DEFAULT_LOCALE][ns])) {
        const en = read(MESSAGES[DEFAULT_LOCALE][ns], path);
        const other = read(MESSAGES[locale][ns], path);
        if (en === undefined || other === undefined) continue;
        const a = placeholders(en);
        const b = placeholders(other);
        if (a.join() !== b.join()) {
          problems.push(
            `${ns}.${path}: en has {${a.join('} {')}}, ${locale} has {${b.join('} {')}}`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('the API formatter can render everything the API reads', () => {
  /*
    The web apps get real ICU from next-intl. The API gets `format()`, which does
    interpolation and one plural form and nothing else — a deliberate choice, since its whole
    surface is email and receipts and the alternative is an intl dependency chain inside a
    NestJS process.

    That choice is only safe while the API's namespaces stay inside what it can render. A
    `select`, an ordinal, or a nested plural added to `emails.json` would render as literal
    braces in somebody's inbox, so it fails here instead.
  */
  const API_NAMESPACES = ['emails', 'documents'] as const;
  const UNSUPPORTED = /\{[^}]*,\s*(select|selectordinal|date|time|number)\b/;

  it.each(LOCALES)('%s', (locale) => {
    const bad: string[] = [];
    for (const ns of API_NAMESPACES) {
      for (const path of paths(MESSAGES[locale][ns])) {
        const value = read(MESSAGES[locale][ns], path) ?? '';
        if (UNSUPPORTED.test(value)) bad.push(`${ns}.${path}: ${value}`);
      }
    }
    expect(
      bad,
      `These use ICU features the API's formatter does not implement:\n  ${bad.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('format', () => {
  it('fills placeholders', () => {
    expect(format('Booking {ref} confirmed', { ref: 'ETG-1' })).toBe('Booking ETG-1 confirmed');
  });

  it('leaves an absent value visible rather than printing undefined', () => {
    // A literal `{ref}` in a support ticket names the bug. "undefined" hides it.
    expect(format('Booking {ref}', {})).toBe('Booking {ref}');
  });

  it('picks the plural form and substitutes the count', () => {
    const tpl = '{count, plural, one {# ticket} other {# tickets}}';
    expect(format(tpl, { count: 1 })).toBe('1 ticket');
    expect(format(tpl, { count: 3 })).toBe('3 tickets');
  });

  it('renders the French plural forms too', () => {
    expect(t('fr-CA', 'emails.fragments.ticketCount', { count: 1 })).toBe('1 billet');
    expect(t('fr-CA', 'emails.fragments.ticketCount', { count: 4 })).toBe('4 billets');
  });
});

describe('resolveLocale', () => {
  it('honours a stored choice above everything else', () => {
    // Somebody telling us their language outranks any guess we could make.
    expect(resolveLocale({ stored: 'en', fromPath: 'fr-CA', acceptLanguage: 'fr-CA' })).toBe('en');
  });

  it('honours the URL when there is no stored choice', () => {
    /*
      A shared /fr-CA/ link has to render in French for whoever opens it, whatever their
      browser is set to — otherwise a French speaker cannot send a French page to anyone.
    */
    expect(resolveLocale({ fromPath: 'fr-CA', acceptLanguage: 'en-GB,en;q=0.9' })).toBe('fr-CA');
  });

  it('matches a French browser loosely', () => {
    // Serving Paris Quebec French beats serving Paris English.
    expect(resolveLocale({ acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.8' })).toBe('fr-CA');
    expect(resolveLocale({ acceptLanguage: 'fr' })).toBe('fr-CA');
  });

  it('respects quality values rather than reading left to right', () => {
    expect(resolveLocale({ acceptLanguage: 'de;q=0.9,fr-CA;q=1.0' })).toBe('fr-CA');
  });

  it('falls back to the default for anything unknown', () => {
    expect(resolveLocale({ acceptLanguage: 'de-DE,de;q=0.9' })).toBe(DEFAULT_LOCALE);
    expect(resolveLocale({})).toBe(DEFAULT_LOCALE);
  });

  it('ignores a stored value that is not a locale we ship', () => {
    // A stale cookie from a locale that was removed must not blank the page.
    expect(resolveLocale({ stored: 'klingon', acceptLanguage: 'en' })).toBe('en');
  });
});

function read(root: unknown, path: string): string | undefined {
  let node: unknown = root;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'string' ? node : undefined;
}
