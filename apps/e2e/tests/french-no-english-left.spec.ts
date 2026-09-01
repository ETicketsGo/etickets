import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API, CUSTOMER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * No English left on the French transactional path.
 *
 * ── WHY A SWEEP AND NOT MORE ASSERTIONS ────────────────────────────────────────────
 * The first French suite walked storefront → confirmation and passed, while the CHECKOUT,
 * the wallet, the login form and the whole mobile bottom bar were still in English. Every
 * test in it was true; none of them looked at those screens. A translation is only finished
 * when nothing on the page is in the other language, and that is a property of the PAGE, not
 * of any one assertion somebody remembered to write.
 *
 * Whole LINES are compared, never substrings: "Explorer" contains "Explore", and a substring
 * check reports the correct French translation as untranslated English. The first version of
 * this scan did exactly that, drowned the real findings in false positives, and separately
 * reported a page as clean while "Sign in" was plainly on it.
 */
const ENGLISH = new Set([
  'Sign in',
  'Sign up',
  'Password',
  'Full name',
  'Create one',
  'Create account',
  'All cities',
  'Review & pay',
  'Discount code',
  'No hidden fees',
  'My experiences',
  'Browse events',
  'Search your wallet',
  'No account?',
  'Ticket status',
  'Total paid',
  'Booking reference',
  'Explore',
  'Browse',
  'Movies',
  'Bookings',
  'Tickets',
  'Alerts',
  'Account',
  'Home',
  'Features',
  'Pricing',
  'For organizers',
  'For attendees',
  'Docs',
  'Get started',
  'Go to app',
  'Help',
  'Email',
  'Remove',
  'Apply',
  'View',
  'Free',
  'Sold out',
  'From',
  'Loading',
  'Subtotal',
  'Continue to payment',
  'Get my tickets',
  // The event detail page. "Sessions" and "Total" are deliberately absent: both are spelled
  // the same in French, and listing them would report a correct translation as a failure.
  'Venue',
  'Organizer',
  'Get directions',
  'Select tickets',
  'Booking fee',
  'Payment fee',
  'This is the full amount you will pay.',
  'Transparent fees shown on the next step.',
]);

/**
 * Screens a customer passes through to buy, hold and show a ticket.
 *
 * The marketing pages are deliberately absent. Their body copy is the owner's translation
 * half (see docs/i18n/README.md), and asserting on it here would either fail forever or have
 * to be silenced — both of which teach people to ignore this file.
 */
const TRANSACTIONAL = [
  '/fr-CA/events',
  /*
    The event detail page — where the money is decided, and the last transactional screen
    this sweep did not look at. It was half translated: the price breakdown had no French
    at all, and "Venue", "Organizer", "Get directions" and "Select tickets" were rendered
    in English beside French body copy. The slug is resolved at run time from the live
    catalogue, because a hardcoded one rots the first time the seed changes.
  */
  '/fr-CA/events/:firstPaid',
  '/fr-CA/login',
  '/fr-CA/register',
  '/fr-CA/account/tickets',
  '/fr-CA/account/bookings',
  '/fr-CA/help',
];

test.describe('the French transactional path carries no English', () => {
  test.describe.configure({ mode: 'serial' });

  let tokens: Awaited<ReturnType<typeof apiLogin>>;
  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, 'customer1@eticketsgo.test');
  });
  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  /** Resolves the `:firstPaid` placeholder against whatever is actually on sale. */
  async function resolve(route: string, request: APIRequestContext): Promise<string> {
    if (!route.includes(':firstPaid')) return route;
    const list = await (await request.get(`${API}/public/events?pageSize=50`)).json();
    const paid = (list.data ?? list).find(
      (e: { fromPriceMinor?: number }) => (e.fromPriceMinor ?? 0) > 0,
    );
    expect(paid, 'a paid event is needed to check the French price breakdown').toBeTruthy();
    return route.replace(':firstPaid', paid.slug);
  }

  for (const route of TRANSACTIONAL) {
    test(route, async ({ page, request }) => {
      const url = await resolve(route, request);
      await page.goto(`${CUSTOMER}${url}`, { waitUntil: 'networkidle', timeout: 45_000 });
      const text = await page.locator('body').innerText();
      const lines = new Set(
        text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
      const found = [...lines].filter((l) => ENGLISH.has(l));
      expect(
        found,
        `${route} still renders English: ${found.join(' | ')}\n` +
          `Add the string to packages/i18n and read it with useTranslations. If it is a ` +
          `proper noun or is spelled the same in French, take it out of ENGLISH above.`,
      ).toEqual([]);
    });
  }
});
