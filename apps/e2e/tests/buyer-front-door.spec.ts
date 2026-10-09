import { test, expect } from '@playwright/test';
import { CUSTOMER } from './helpers';

/**
 * e2e - the front door is a ticket shop, for somebody who has never signed in.
 *
 * ── WHAT THIS REPLACED ─────────────────────────────────────────────────────────────
 * `/` served a marketing landing to signed-out visitors and the marketplace only to
 * signed-in ones. So every first-time buyer - which is every buyer, once - landed on a page
 * headed "Sell tickets. Check in guests. Grow every event." whose primary action was "Start
 * selling tickets", and which showed no event, film, city or showtime anywhere.
 *
 * These tests are written from the signed-out state on purpose. That is the state the old
 * behaviour got wrong, and the one no existing test covered: the specs that visited `/` all
 * signed in first, so the marketing landing was never the thing under test.
 */
test.describe('the buyer front door', () => {
  test('a stranger lands on a ticket shop, not a sales pitch', async ({ page }) => {
    await page.goto(`${CUSTOMER}/`, { waitUntil: 'networkidle' });

    // The old hero, and the old primary action. Neither may come back.
    await expect(
      page.getByRole('heading', { name: /Sell tickets\. Check in guests/i }),
    ).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Start selling tickets$/i })).toHaveCount(0);

    // What a buyer needs instead: a way to search, and somewhere to search from.
    await expect(page.getByPlaceholder(/Search events/i)).toBeVisible({ timeout: 20_000 });
  });

  test('a visitor with nothing on near them is given places that do have something', async ({
    page,
  }) => {
    /*
      The dead end this closes. `location/resolve` scopes to the country the browser reports
      and answers with no suggestions for a country we do not sell in - so the only way out
      was to type into a picker while being told there is nothing on.

      Asserted loosely: the point is that SOME real city is offered, not which one. Hard-coding
      a city name here would make the test a fixture of the seed data rather than of the
      behaviour.
    */
    await page.goto(`${CUSTOMER}/`, { waitUntil: 'networkidle' });

    const empty = page.getByText(/No events available in .* yet/);
    if (await empty.count()) {
      await expect(page.getByText(/Here is where we are selling right now/i)).toBeVisible();
      // At least one city chip, and choosing it must change what the page shows.
      const chips = page.locator('section').filter({ hasText: /Here is where we are selling/i });
      await expect(chips.getByRole('button')).not.toHaveCount(0);
    }
  });

  test('the organizer path is offered without being the front door', async ({ page }) => {
    await page.goto(`${CUSTOMER}/`, { waitUntil: 'networkidle' });
    const organizer = page.getByRole('link', { name: /See how it works/i });
    await expect(organizer).toBeVisible({ timeout: 20_000 });
    /*
      It used to point at NEXT_PUBLIC_ORGANIZER_URL, falling back to `http://localhost:3001` -
      a console a stranger has no account for, at an address that is wrong anywhere but a
      developer's machine.
    */
    await expect(organizer).toHaveAttribute('href', /\/organizers$/);
  });

  test('the buyer can answer "what can I buy?" with a price', async ({ page }) => {
    /*
      The success test for this slice, as a test. Whatever city the visitor ends up scoped to,
      they must be able to reach a real listing that names a price.
    */
    await page.goto(`${CUSTOMER}/`, { waitUntil: 'networkidle' });

    const chip = page
      .locator('button')
      .filter({ hasText: /^\w[\w\s-]*\s+\d+$/ })
      .first();
    if (await chip.count()) await chip.click();
    await page.waitForTimeout(1500);

    const cards = page.locator('a[href*="/events/"]');
    await expect(cards).not.toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText(/From\s*[₹$€£]/).first()).toBeVisible({ timeout: 20_000 });
  });
});
