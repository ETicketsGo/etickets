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
  // The premium pass (P2): the dark page, the paper ticket, the perforation.
  'components/pass-brand.tsx',
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
  // Following organizers and the email unsubscribe link (workstream 1).
  'components/follow-button.tsx',
  'app/[locale]/unsubscribe/[token]/page.tsx',
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
  'components/marketing/header.tsx',
  'components/marketing/footer-sign-in-link.tsx',
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

  it('gives the marketing routes a brand marketing header, not the old blue one', () => {
    // The old blue MarketingNav is gone. The marketing routes take MarketingHeader, drawn on
    // the brand layer like the storefront Header (N1: one design, two navigations); the
    // behaviour is pinned in lib/audience-navigation.test.ts.
    const chrome = read('components/site-chrome.tsx');
    expect(chrome).not.toMatch(/MarketingNav/);
    expect(chrome.match(/<Header\s/g)).toHaveLength(1);
    expect(chrome.match(/<MarketingHeader\s/g)).toHaveLength(1);
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
  // The editorial event page (P1, owner design 2026-10-19): its reservation card and phone bar.
  'components/event-reservation.tsx',
  'components/sticky-continue.tsx',
];

/**
 * Files that are only PARTLY on the brand layer, each with what stays and why. Checked for
 * unknown brand classes only.
 *   phone-number-field: `brand` is opt-in; it is still drawn in the old look somewhere.
 * (guest-booking-view and reference-code moved fully; see the leftovers suite below.)
 */
const PARTLY_MOVED = ['components/phone-number-field.tsx'];

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

  it('scopes the print route itself: its toolbar and its empty state open the brand layer', () => {
    // The print route has no shell (site-chrome draws only <main>), so nothing above it does.
    const source = read('components/guest-booking-view.tsx');
    const sheet = source.slice(source.indexOf('export function GuestPrintSheet'));
    expect(sheet.match(/data-brand="customer"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
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

/*
  ── THE LAST LEFTOVERS: THE 404, THE FEEDBACK DIALOG, THE GUEST PANEL, AND WHAT EVERY PAGE SHARES ─
  A sweep of all 64 storefront routes on 7fc654a found the old system in the pieces the earlier
  rounds did not own: the 404 (a bare grey page with no header, no footer and so no legal line),
  the "Send feedback" dialog every footer opens, the "Buy as a guest" panel on the main signed-out
  purchase path, the Sample/Test badge, the skip link, the help forms' fields, the install and
  update toasts, the kit dialog and drawer frames, and old-system variants nobody called any more.

  The variants with no caller were DELETED rather than restyled (event-card, movie-card, and the
  classic branches of price-breakdown, place-sections, reference-code and language-switcher), so
  the check here is simply that none of the old system is left in the files that remain.
*/
const LEFTOVER_FILES = [
  'app/[locale]/not-found.tsx',
  'app/[locale]/[...rest]/page.tsx',
  'app/not-found.tsx',
  'components/not-found-view.tsx',
  'components/not-found-shell.tsx',
  'components/feedback-widget.tsx',
  'components/guest-buyer.tsx',
  'components/content-label-badge.tsx',
  'components/skip-to-content.tsx',
  'components/install-prompt.tsx',
  'components/sw-register.tsx',
  'components/reference-code.tsx',
  'components/guest-booking-view.tsx',
  'components/price-breakdown.tsx',
  'components/place-sections.tsx',
  'components/language-switcher.tsx',
  'components/event-details.tsx',
  'components/localized-ui.tsx',
  'components/ui.tsx',
  'components/site-footer.tsx',
  'app/[locale]/booking/access/[token]/print/page.tsx',
  'app/[locale]/booking/[id]/tickets/print/page.tsx',
];

/** Pieces that sit outside any page's brand scope, so each must open one of its own. */
const SELF_SCOPED = [
  'components/skip-to-content.tsx',
  'components/install-prompt.tsx',
  'components/sw-register.tsx',
];

/** Components that drew the old kit's fields and buttons, which paint themselves in the old tokens. */
const NO_OLD_KIT = [
  'components/not-found-view.tsx',
  'components/feedback-widget.tsx',
  'components/feedback-form.tsx',
  'components/guest-buyer.tsx',
  'components/event-details.tsx',
  'components/place-sections.tsx',
];

/** The shared kit, whose dialog, drawer and stars gained an opt-in brand frame. */
const WEB_KIT = join(ROOT, '..', '..', 'packages', 'web-kit', 'src');

describe('the 404, the feedback dialog, the guest panel and the shared leftovers', () => {
  it.each(LEFTOVER_FILES)('%s uses none of the old system', (file) => {
    const source = read(file);
    const found = LEGACY.flatMap((pattern) => source.match(pattern) ?? []);
    // The class names the sweep looks for, spelled however a variant might write them.
    const swept = source.match(/action-primary|\btext-text-|\bbg-background-/g) ?? [];
    expect([...found, ...swept]).toEqual([]);
  });

  it.each([...LEFTOVER_FILES, ...NO_OLD_KIT])(
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

  it.each(NO_OLD_KIT)('%s draws no old kit field or button', (file) => {
    const kit = read(file).match(/<(?:Button|ButtonLink|Card|Input|Select|Textarea|EmptyState)\b/g);
    expect(kit ?? []).toEqual([]);
  });

  it.each(SELF_SCOPED)('%s opens the brand layer itself', (file) => {
    expect(read(file)).toMatch(/data-brand="customer"/);
  });

  it('draws both 404s on the brand page, and reaches the one inside the shell', () => {
    expect(read('components/not-found-view.tsx')).toMatch(/<BrandPage>/);
    expect(read('app/[locale]/not-found.tsx')).toMatch(/<NotFoundView\s*\/>/);
    expect(read('app/not-found.tsx')).toMatch(/<NotFoundInShell\b/);
    expect(read('components/not-found-shell.tsx')).toMatch(/<SiteChrome\b[\s\S]*<NotFoundView/);
    expect(read('app/[locale]/[...rest]/page.tsx')).toMatch(/notFound\(\)/);
  });

  it('gives every storefront dialog, drawer and star rating the brand frame', () => {
    const wrappers = read('components/localized-ui.tsx');
    expect(wrappers).toMatch(/<KitDialog brand\b/);
    expect(wrappers).toMatch(/<KitDrawer brand\b/);
    expect(wrappers).toMatch(/<KitRatingStars\s+brand\b/);
    // And the app takes them from there, never straight from the kit.
    const ui = read('components/ui.tsx');
    expect(ui).toMatch(
      /export \{ Dialog, Drawer, ErrorState, RatingStars, Stepper \} from '\.\/localized-ui'/,
    );
    expect(ui.slice(ui.indexOf("from './localized-ui'"))).not.toMatch(/\bDialog\b/);
  });

  it('scopes the kit frame itself, so a dialog opened from the dark footer is still paper', () => {
    const kit = codeOnly(readFileSync(join(WEB_KIT, 'components.tsx'), 'utf8'));
    expect(kit.match(/data-brand=\{brand \? 'customer' : undefined\}/g)).toHaveLength(2);
  });

  it("names only brand colours that exist in the kit's brand frame", () => {
    const { colours, sizes } = brandNames();
    const kit = codeOnly(readFileSync(join(WEB_KIT, 'components.tsx'), 'utf8'));
    const offenders: string[] = [];
    for (const [, prefix, name] of kit.matchAll(
      /(?:^|[\s'"`:])(?:[a-z0-9-]+:)*(bg|text|border|ring|fill|ring-offset)-brand-([a-z0-9-]+?)(?=[\s'"`]|$)/g,
    )) {
      const ok = prefix === 'text' ? colours.has(name) || sizes.has(name) : colours.has(name);
      if (!ok) offenders.push(`${prefix}-brand-${name}`);
    }
    expect(offenders).toEqual([]);
  });

  it('deleted the old cards rather than keeping a second look-alike', () => {
    for (const file of ['components/event-card.tsx', 'components/movie-card.tsx']) {
      expect(() => readFileSync(join(ROOT, file))).toThrow();
    }
  });

  it("draws the admin console's header with the one wordmark", () => {
    // Not a storefront file, but the same brand: admin showed the old gradient ticket, then its
    // favicon as a stand-in (#431). It now draws the shell's wordmark like every other surface
    // (owner, 2026-10-19; web-kit wordmark.test.tsx pins the rest).
    const admin = codeOnly(
      readFileSync(join(ROOT, '..', 'admin-web', 'components', 'admin-shell.tsx'), 'utf8'),
    );
    expect(admin).not.toMatch(/renderMark|src="\/icon\.svg"/);
    const shell = codeOnly(readFileSync(join(WEB_KIT, 'shell.tsx'), 'utf8'));
    expect(shell).not.toMatch(/LogoMark|renderMark/);
    expect(shell.match(/<Wordmark /g)).toHaveLength(3);
  });
});

/*
  ── THE PASS KEEPS ITS QR SCANNABLE (P2, 2026-10-19) ─────────────────────────────────────
  The pass pages were redrawn as a paper ticket on a dark page. The QR is the one thing on them
  a machine reads, so its drawing is pinned: the same 224px box, on white, with the server's own
  image (its size and error correction are the API's). A dark page must never tint it or shrink
  it, and the TRANSFER on My tickets must stay behind the stub's `transferable` flag.
*/
describe('the pass keeps its QR as it was', () => {
  const PASS_PAGES = [
    'app/[locale]/account/tickets/[ticketId]/page.tsx',
    'app/[locale]/account/bookings/[bookingId]/tickets/page.tsx',
  ];

  it.each(PASS_PAGES)('%s draws the QR at 224px on white, inside the paper card', (file) => {
    const source = read(file);
    expect(source).toMatch(
      /className=\{?[`"]h-56 w-56 rounded-brand-control border border-brand-line bg-white p-2/,
    );
    expect(source).toMatch(/<PassCard[\s>]/);
    expect(source).toMatch(/<PassStage>/);
  });

  it('the paper card puts the paper tokens back inside the dark page', () => {
    expect(read('components/pass-brand.tsx')).toMatch(/data-brand="customer"/);
  });

  it('offers TRANSFER on a stub only when the booking has a transferable ticket', () => {
    expect(read('components/wallet-card.tsx')).toMatch(/info\?\.transferable && \(/);
  });
});
