import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import preset from '@eticketsgo/design-tokens/tailwind-preset';

/*
  ── EXPLORE, MOVIES, THE FILM PAGE AND MY TICKETS STAY ON THE BRAND LAYER ─────────────────
  The owner's review: "Explore, Movies and Tickets pages still have old UI and UX stuff, please
  match with updated UI". These were the last buyer pages drawn with the old system's tokens
  (blue `action-primary`, `background-*` greys, pastel `gradientFor` tiles, shadowed cards) next
  to a home page and booking flow already on the stage-and-paper brand layer.

  Two ways back to that state, both silent:
    1. Someone adds an old-system class to one of these files. It still renders (the old tokens
       are global), so nothing fails - the page is just two products again.
    2. Someone writes a `brand-*` class that does not exist. Tailwind generates nothing for an
       unknown class, so the element is simply unstyled (the Toggle bug: a switch that worked
       and looked dead). Nothing throws, no type checker knows.

  This reads the files and checks both. Comments are stripped first: a comment that NAMES an
  old class to explain why it went is prose, not a class.
*/

const ROOT = join(__dirname, '..');

/** Every file this workstream moved onto the brand layer. */
const BRAND_FILES = [
  'app/[locale]/explore/page.tsx',
  'app/[locale]/movies/page.tsx',
  'app/[locale]/movies/[slug]/page.tsx',
  'app/[locale]/account/tickets/page.tsx',
  'app/[locale]/account/tickets/[ticketId]/page.tsx',
  'components/storefront-brand.tsx',
  'components/wallet-card.tsx',
  'components/wallet-passes.tsx',
  'components/showtimes/availability-legend.tsx',
  'components/showtimes/cinema-card.tsx',
  'components/showtimes/date-strip.tsx',
  'components/showtimes/showtime-filters.tsx',
  'components/showtimes/showtime-pill.tsx',
  'components/showtimes/showtimes-skeleton.tsx',
  'components/reviews/movie-ratings.tsx',
  'components/reviews/rate-movie-panel.tsx',
  'components/reviews/rating-summary.tsx',
  'components/reviews/recent-reviews.tsx',
  /*
    The marketing, legal and help pages (U1): the last storefront pages on the old blue
    MarketingShell, and the shared pieces they are built from.
  */
  ...[
    'about',
    'contact',
    'features',
    'solutions',
    'pricing',
    'sell',
    'customers',
    'organizers',
    'organizers/[id]',
    'faq',
    'changelog',
    'blog',
    'blog/[slug]',
    'docs',
    'docs/api',
    'legal',
    'terms',
    'privacy',
    'refunds',
    'sms',
    'cookies',
    'organizer-agreement',
    'help',
    'help/bug',
    'help/complaint',
    'help/contact',
    'help/feature',
  ].map((route) => `app/[locale]/${route}/page.tsx`),
  'components/marketing/kit.tsx',
  'components/marketing/blocks.tsx',
  'components/marketing/landing.tsx',
  'components/marketing/faq.tsx',
  'components/marketing/contact-form.tsx',
  'components/marketing/footer.tsx',
  'components/legal/policy-chrome.tsx',
  'components/legal/legal-business-information.tsx',
  'components/feedback-form.tsx',
];

/** The pages themselves, which must each put themselves on the brand layer. */
const PAGES = BRAND_FILES.filter((f) => f.startsWith('app/'));

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const read = (file: string) => codeOnly(readFileSync(join(ROOT, file), 'utf8'));

/** The old system's tokens and helpers. Any of these in a brand file is the old look leaking back. */
const LEGACY = [
  /\b(?:bg|text|border|ring|from|to|fill)-(?:background|text|action-primary|status|tint)-[a-z-]+/,
  /\bborder-border\b/,
  /\bdivide-border\b/,
  /\btext-(?:caption|title|h1|h2|h3|hero)\b/,
  /\bshadow-(?:sm|md|lg)\b/,
  /\bgradientFor\b/,
  /\bease-premium\b/,
];

function brandNames(): { colours: Set<string>; sizes: Set<string> } {
  const theme = (preset as { theme?: { extend?: Record<string, Record<string, unknown>> } }).theme
    ?.extend;
  const brand = (theme?.colors?.brand ?? {}) as Record<string, unknown>;
  return {
    colours: new Set(Object.keys(brand).map((k) => (k === 'DEFAULT' ? '' : k))),
    sizes: new Set(
      Object.keys(theme?.fontSize ?? {})
        .filter((k) => k.startsWith('brand-'))
        .map((k) => k.slice('brand-'.length)),
    ),
  };
}

describe('Explore, Movies, the film page and My tickets are on the brand layer', () => {
  it.each(PAGES)('%s puts itself on the brand layer', (file) => {
    expect(read(file)).toMatch(/<BrandPage>/);
  });

  it('gives the marketing routes the storefront header, not the old blue one', () => {
    // The old MarketingNav ("Go to app", blue "Get started") is gone; every route renders the
    // same Header, and only the footer's link columns differ on the marketing routes.
    const chrome = read('components/site-chrome.tsx');
    expect(chrome).not.toMatch(/MarketingNav/);
    expect(chrome.match(/<Header\s/g)).toHaveLength(1);
    expect(chrome).toMatch(/<MarketingFooter\s/);
  });

  it.each(BRAND_FILES)('%s uses none of the old system', (file) => {
    const source = read(file);
    const found = LEGACY.flatMap((pattern) => source.match(pattern) ?? []);
    expect(found).toEqual([]);
  });

  it('has a brand palette and type scale to check against', () => {
    // A guard on the guard: an empty preset would let every check below pass vacuously.
    const { colours, sizes } = brandNames();
    expect(colours.has('ink')).toBe(true);
    expect(sizes.has('card')).toBe(true);
  });

  it.each(BRAND_FILES)('%s names only brand colours and sizes that exist', (file) => {
    const { colours, sizes } = brandNames();
    const offenders: string[] = [];
    const pattern =
      /(?:^|[\s'"`:])(?:[a-z0-9[\]=-]+:)*(bg|text|border|ring|fill|divide|decoration|from|via|to|ring-offset)-brand-([a-z0-9-]+?)(?:\/\d+)?(?=[\s'"`]|$)/g;
    for (const [, prefix, name] of read(file).matchAll(pattern)) {
      const ok = prefix === 'text' ? colours.has(name) || sizes.has(name) : colours.has(name);
      if (!ok) offenders.push(`${prefix}-brand-${name}`);
    }
    expect(offenders).toEqual([]);
  });
});

/*
  ── SIGN-IN, THE SHORT PAGES AROUND A PURCHASE, BROWSE AND THE BOOKING FLOW'S LEFTOVERS ─────
  The owner, 2026-10-18: "still lot of pages having old UI". Sign-in and sign-up, the two
  password pages, Browse, Find my booking, the emailed booking link, the cash reservation, the
  checkout returns, a shared ticket and an attendee invitation moved onto the brand layer, with
  the shared pieces they draw (the forms kit, the grid card, the phone sign-in, the guest cards).
  The booking flow's four pages had already moved but still drew their loading and error states,
  a review box and the "you might also like" cards in the old system; those moved too.

  The same two checks as above. These pages put themselves on the brand layer through one of
  three wrappers - `BrandPage`, or the forms kit's `BrandCenteredPage` / `BrandStatePage`, which
  are BrandPage - or, for the flow's own shells, `data-brand="customer"` directly.
*/
const MOVED_PAGES = [
  'app/[locale]/login/page.tsx',
  'app/[locale]/register/page.tsx',
  'app/[locale]/forgot-password/page.tsx',
  'app/[locale]/reset-password/page.tsx',
  'app/[locale]/events/page.tsx',
  'app/[locale]/booking/find/page.tsx',
  'app/[locale]/booking/access/[token]/page.tsx',
  'app/[locale]/booking/[id]/reserved/page.tsx',
  'app/[locale]/booking/[id]/confirmation/page.tsx',
  'app/[locale]/booking/[id]/payment/page.tsx',
  'app/[locale]/shows/[sessionId]/page.tsx',
  'app/[locale]/events/[slug]/page.tsx',
  'app/[locale]/checkout/success/page.tsx',
  'app/[locale]/checkout/cancel/page.tsx',
  'app/[locale]/share/[token]/page.tsx',
  'app/[locale]/invite/[token]/page.tsx',
];

const MOVED_FILES = [
  ...MOVED_PAGES,
  'components/brand-forms.tsx',
  'components/brand-event-card.tsx',
  'components/phone-sign-in.tsx',
  'components/guest-self-service.tsx',
];

/**
 * Files that are only PARTLY on the brand layer, each with what stays and why. Checked for
 * unknown brand classes only.
 *   guest-booking-view: the print sheet is built for a bare page and paper (no brand shell).
 *   phone-number-field, reference-code: `brand` is opt-in; the account pages still use the old look.
 */
const PARTLY_MOVED = [
  'components/guest-booking-view.tsx',
  'components/phone-number-field.tsx',
  'components/reference-code.tsx',
];

describe('sign-in, Browse, the short booking pages and the flow leftovers are on the brand layer', () => {
  it.each(MOVED_PAGES)('%s puts itself on the brand layer', (file) => {
    expect(read(file)).toMatch(/<Brand(?:Page|CenteredPage|StatePage)\b|data-brand="customer"/);
  });

  it.each(MOVED_FILES)('%s uses none of the old system', (file) => {
    const source = read(file);
    const found = LEGACY.flatMap((pattern) => source.match(pattern) ?? []);
    expect(found).toEqual([]);
  });

  it.each(MOVED_PAGES)('%s draws no old kit button, card, field or state', (file) => {
    // The old kit's pieces paint themselves in the old tokens wherever they are put.
    const source = read(file);
    const kit = source.match(
      /<(?:Button|ButtonLink|Card|Input|Select|Textarea|PasswordField|ErrorState|EmptyState|Skeleton|Spinner|StatusBadge|EventCard|MovieCard)\b/g,
    );
    expect(kit ?? []).toEqual([]);
  });

  it('keeps the old print sheet out of the brand layer, and the rest of the guest view in it', () => {
    const source = read('components/guest-booking-view.tsx');
    const sheet = source.slice(source.indexOf('export function GuestPrintSheet'));
    const rest = source.slice(0, source.indexOf('export function GuestPrintSheet'));
    const legacyIn = (text: string) => LEGACY.flatMap((pattern) => text.match(pattern) ?? []);
    expect(legacyIn(rest)).toEqual([]);
    // The card shown before any shell (and on the bare print route) scopes itself.
    expect(sheet).toMatch(/data-brand="customer"/);
  });

  it.each([...MOVED_FILES, ...PARTLY_MOVED])(
    '%s names only brand colours and sizes that exist',
    (file) => {
      const { colours, sizes } = brandNames();
      const offenders: string[] = [];
      const pattern =
        /(?:^|[\s'"`:!])(?:[a-z0-9[\]=-]+:)*!?(bg|text|border|ring|fill|divide|decoration|from|via|to|ring-offset|accent)-brand-([a-z0-9-]+?)(?:\/\d+)?(?=[\s'"`]|$)/g;
      for (const [, prefix, name] of read(file).matchAll(pattern)) {
        const ok = prefix === 'text' ? colours.has(name) || sizes.has(name) : colours.has(name);
        if (!ok) offenders.push(`${prefix}-brand-${name}`);
      }
      expect(offenders).toEqual([]);
    },
  );
});
