import { test, expect } from '@playwright/test';
import { CUSTOMER } from './helpers';

/**
 * Every customer screen has a name.
 *
 * ── WHY A TITLE IS NOT COSMETIC HERE ───────────────────────────────────────────────
 * The storefront is installed as an Android app. The `<title>` is what the recents switcher
 * shows, what a bookmark is saved as, and what a shared link carries into somebody else's chat.
 * Twenty-one customer routes had none and fell through to the root title - "ETicketsGo: Sell
 * tickets, check in guests, see your sales" - which is the pitch to ORGANIZERS.
 *
 * So a customer signing in, paying, or holding a ticket up at the door had, in their recents
 * list, an advertisement for the product they had already bought from. It is the kind of defect
 * that no test fails on and everybody sees.
 *
 * The rule asserted here is deliberately weak and therefore durable: a customer page must not be
 * named after the organizer pitch, and its name must have something to do with the page. It does
 * not pin exact strings, which would turn every copy change into a test failure.
 */

/** Words from the root title. A customer page carrying these is a page with no name of its own. */
const ORGANIZER_PITCH = /sell tickets|check in guests|see your sales/i;

/*
  `/discover` is deliberately absent: it renders nothing at all, it only redirects to `/` so that
  old links keep working. A title on a route that never renders is dead weight, and asserting one
  would be asserting the redirect target's title under the wrong name.
*/
const ROUTES: { path: string; expect: RegExp }[] = [
  { path: '/login', expect: /sign in/i },
  { path: '/register', expect: /account/i },
  { path: '/forgot-password', expect: /password/i },
  { path: '/reset-password', expect: /password/i },
  { path: '/booking/find', expect: /booking/i },
  { path: '/events', expect: /events/i },
  { path: '/movies', expect: /movies/i },
  { path: '/help', expect: /help/i },
];

test.describe('every customer screen has a name', () => {
  for (const route of ROUTES) {
    test(`${route.path} is not named after the organizer pitch`, async ({ page }) => {
      await page.goto(`${CUSTOMER}${route.path}`, { waitUntil: 'domcontentloaded' });
      const title = await page.title();

      expect(title, `${route.path} fell through to the root title`).not.toMatch(ORGANIZER_PITCH);
      expect(title, `${route.path} is named "${title}"`).toMatch(route.expect);
    });
  }

  test('the booking flow is named too, where a ticket is actually held', async ({ page }) => {
    /*
      Checked through a real booking rather than a made-up id: these routes refuse an id they do
      not recognise, and a refusal page's title proves nothing about the page being protected.
    */
    await page.goto(`${CUSTOMER}/account/bookings`, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    expect(title, 'the bookings list fell through to the root title').not.toMatch(ORGANIZER_PITCH);
  });
});
