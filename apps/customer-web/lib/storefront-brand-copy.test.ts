import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
  ── EXPLORE AND MOVIES SPEAK THE READER'S LANGUAGE ─────────────────────────────────────
  When Explore and Movies moved onto the brand layer their copy was written inline, in English,
  so a visitor who chose Francais in the footer read French everywhere else and English on the
  two pages the top navigation leads to. Every word now comes from the `@eticketsgo/i18n`
  catalogue.

  The way back is silent: an English sentence typed into one of these files renders, passes
  the type checker and every other test, and is only noticed by a French reader. This reads the
  files and fails on the shapes such a sentence takes - JSX text, a literal in a user-facing
  prop, a capitalised phrase in quotes - and checks every key the pages ask for exists.
  Comments are stripped first: prose that QUOTES the old copy to explain it is not copy.
*/

const ROOT = join(__dirname, '..');
const MESSAGES = join(ROOT, '..', '..', 'packages', 'i18n', 'src', 'messages');

/** The files whose every visible word must come from the catalogue. */
const FILES = [
  'app/[locale]/explore/page.tsx',
  'app/[locale]/movies/page.tsx',
  'components/storefront-brand.tsx',
  'components/place-sections.tsx',
  'components/home/parts.tsx',
  // The 404 (U5): the page a stranger following a dead link reads, in their language.
  'components/not-found-view.tsx',
];

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const read = (file: string) => codeOnly(readFileSync(join(ROOT, file), 'utf8'));

/** Words between tags: `<h1>Movies</h1>`, `<option>All genres</option>`. */
function jsxText(source: string): string[] {
  return (
    [...source.matchAll(/>([^<>{}]*)</g)]
      .map((m) => m[1].trim())
      .filter((text) => /[A-Za-z]{2,}/.test(text))
      // `=>` and generics are code, not text: `(e) => e.slug` puts a `>` before letters.
      .filter((text) => !/[=;()]|\b(?:const|return|typeof)\b/.test(text))
  );
}

/** A literal in a prop a reader sees or hears: `aria-label="Movies"`, `title={'Now showing'}`. */
function literalProps(source: string): string[] {
  const props = '(?:aria-label|title|hint|label|placeholder|alt|eyebrow)';
  const pattern = new RegExp(
    `\\b${props}=(?:"([^"]*[A-Za-z][^"]*)"|\\{\\s*['\`]([^'\`]*[A-Za-z][^'\`]*)['\`]\\s*\\})`,
    'g',
  );
  return [...source.matchAll(pattern)].map((m) => m[0]);
}

/** A capitalised phrase of two or more words in quotes: `'Sales closed'`, `\`No films yet\``. */
function quotedPhrases(source: string): string[] {
  return [...source.matchAll(/(['"`])([A-Z][a-z]+(?: [A-Za-z${}.,:!?-]+)+)\1/g)].map((m) => m[2]);
}

describe('Explore and Movies have no English written into the page', () => {
  it.each(FILES)('%s has no English text between tags', (file) => {
    expect(jsxText(read(file))).toEqual([]);
  });

  it.each(FILES)('%s has no English literal in a label, title, hint or placeholder', (file) => {
    expect(literalProps(read(file))).toEqual([]);
  });

  it.each(FILES)('%s has no English phrase in quotes', (file) => {
    expect(quotedPhrases(read(file))).toEqual([]);
  });

  it('catches each shape it is meant to catch', () => {
    // A guard on the guard: if a pattern stopped matching, every check above would pass.
    expect(jsxText('<h1 className="x">Movies</h1>')).toEqual(['Movies']);
    expect(literalProps('<Rail label="Now showing">')).toEqual(['label="Now showing"']);
    expect(literalProps("<input placeholder={'Title...'} />")).toHaveLength(1);
    expect(quotedPhrases("meta: `${n} events, verified` || 'Sales closed'")).toEqual([
      'Sales closed',
    ]);
    expect(jsxText("<p>{t('lead')}</p>")).toEqual([]);
  });
});

/** Every `t('key')` a file asks of one namespace, given the variable it binds that namespace to. */
function keysAsked(source: string, binding: string): string[] {
  return [...source.matchAll(new RegExp(`\\b${binding}\\(\\s*'([A-Za-z0-9]+)'`, 'g'))].map(
    (m) => m[1],
  );
}

function namespace(locale: string, ns: string): Record<string, unknown> {
  const all = JSON.parse(readFileSync(join(MESSAGES, locale, 'storefront.json'), 'utf8'));
  return all[ns] ?? {};
}

describe('every message Explore and Movies ask for exists in English and French', () => {
  const cases: [string, string, string][] = [
    ['app/[locale]/explore/page.tsx', 't', 'explore'],
    ['app/[locale]/movies/page.tsx', 't', 'movies'],
    ['components/place-sections.tsx', 't', 'placeGroups'],
  ];
  it.each(cases)('%s (%s -> storefront.%s)', (file, binding, ns) => {
    const source = read(file);
    expect(source).toContain(`useTranslations('storefront.${ns}')`);
    const asked = keysAsked(source, binding);
    expect(asked.length).toBeGreaterThan(0);
    for (const locale of ['en', 'fr-CA']) {
      const messages = namespace(locale, ns);
      expect(asked.filter((key) => typeof messages[key] !== 'string')).toEqual([]);
    }
  });

  it('every section title the page maps by key exists', () => {
    const source = read('app/[locale]/explore/page.tsx');
    const mapped = [...source.matchAll(/:\s*'(section[A-Za-z]+)'/g)].map((m) => m[1]);
    expect(mapped.length).toBeGreaterThan(0);
    for (const locale of ['en', 'fr-CA']) {
      const messages = namespace(locale, 'explore');
      expect(mapped.filter((key) => typeof messages[key] !== 'string')).toEqual([]);
    }
  });

  it('keeps the English copy in ASCII', () => {
    const english = JSON.stringify(
      ['explore', 'movies', 'placeGroups'].map((ns) => namespace('en', ns)),
    );
    expect(english.match(/[^\x20-\x7e]/g) ?? []).toEqual([]);
  });
});
