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
  // The rest of the account (workstream U2): the owner saw a booking's tickets page in the old
  // design next to the single ticket page #400 had already moved.
  'app/[locale]/account/page.tsx',
  'app/[locale]/account/profile/page.tsx',
  'app/[locale]/account/bookings/page.tsx',
  'app/[locale]/account/bookings/[bookingId]/tickets/page.tsx',
  'app/[locale]/account/bookings/[bookingId]/tickets/print/page.tsx',
  'app/[locale]/account/receipts/page.tsx',
  'app/[locale]/account/saved/page.tsx',
  'app/[locale]/account/following/page.tsx',
  'app/[locale]/account/notifications/page.tsx',
  'app/[locale]/account/notification-settings/page.tsx',
  'app/[locale]/account/become-organizer/page.tsx',
  'components/account-brand.tsx',
  'components/event-day-mode.tsx',
  'components/share-dialog.tsx',
  'components/assign-attendee-dialog.tsx',
  'components/push-toggle.tsx',
  'components/sign-in-required.tsx',
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
  /*
    A page is on the layer when it renders BrandPage, or the account pages' AccountPage (which
    is BrandPage with the account column inside), or - for the print sheet, which has no app
    shell to take padding back from - sets `data-brand="customer"` itself.
  */
  it.each(PAGES)('%s puts itself on the brand layer', (file) => {
    expect(read(file)).toMatch(/<BrandPage>|<AccountPage[\s>]|data-brand="customer"/);
  });

  it('AccountPage is BrandPage underneath', () => {
    expect(read('components/account-brand.tsx')).toMatch(/<BrandPage>/);
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
