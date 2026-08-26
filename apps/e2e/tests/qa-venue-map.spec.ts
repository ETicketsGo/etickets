import { test, expect, type Page } from '@playwright/test';

/**
 * The venue map, on QA, in a browser.
 *
 * The API side is proven by the integration suite; what this checks is the half that only
 * exists in the deployed client — that eleven thousand seats arrive as a picture, that a
 * block opens, and that a basket survives moving around the venue.
 *
 * SESSION_ID is a show built on QA by hand (an arena on its own screen). Set it via the
 * environment when re-running against a freshly built one.
 */
const CUSTOMER = 'https://customer-web-qa.up.railway.app';
const SESSION_ID = process.env.QA_ARENA_SESSION ?? '';

const open = (page: Page, url: string) => page.goto(url, { waitUntil: 'networkidle' });

test.describe('QA: a venue too big to list', () => {
  test.skip(!SESSION_ID, 'set QA_ARENA_SESSION to the arena show built on QA');

  test('arrives as a map, not eleven thousand seats', async ({ page }) => {
    await open(page, `${CUSTOMER}/shows/${SESSION_ID}`);
    await expect(page.getByRole('heading', { name: 'Choose your area' })).toBeVisible();
    await expect(page.getByRole('group', { name: /venue map/i })).toBeVisible();
    await expect(page.getByText('STAGE', { exact: true })).toBeVisible();
    // The thing being avoided: no seat grid on the first screen.
    await expect(page.getByRole('button', { name: /^Seat /i })).toHaveCount(0);
  });

  test('every block says how full it is and what it costs', async ({ page }) => {
    await open(page, `${CUSTOMER}/shows/${SESSION_ID}`);
    // The accessible name carries the same three facts the picture does, so the map is not
    // a mouse-only feature.
    await expect(
      page.getByRole('button', { name: /Floor A, \d+ of \d+ seats available, from/ }),
    ).toBeVisible();
    await expect(page.getByText('Seats available')).toBeVisible();
    await expect(page.getByText('Sold out')).toBeVisible();
  });

  test('a block opens into its own seats, and the basket survives going back', async ({ page }) => {
    await open(page, `${CUSTOMER}/shows/${SESSION_ID}`);
    await page.getByRole('button', { name: /^Floor A,/ }).click();

    await expect(page.getByRole('heading', { name: 'Floor A' })).toBeVisible();
    const backToMap = page.getByRole('button', { name: 'Back to the venue map' });
    await expect(backToMap).toBeVisible();

    /*
      The first AVAILABLE seat, not seat A1 specifically.

      Naming one seat made this spec depend on nobody having bought it — and the booking spec
      beside it buys exactly that one. The failure was honest: A1 came back disabled and
      labelled "sold", which is the inventory working correctly. Taking whatever is free
      keeps this test about the basket rather than about the seating chart.
    */
    const seat = page.locator('button[aria-label^="Seat"][aria-label*="available" i]').first();
    await expect(seat).toBeVisible({ timeout: 30_000 });
    const chosen = /Seat\s+([A-Z]+\d+)/i.exec((await seat.getAttribute('aria-label')) ?? '')?.[1];
    expect(chosen, 'the seat should be named with its row').toBeTruthy();
    await seat.click();
    await expect(page.getByText(chosen!, { exact: false }).first()).toBeVisible();

    await backToMap.click();
    await expect(page.getByRole('heading', { name: 'Choose your area' })).toBeVisible();
    // Said out loud on the map, so an empty sidebar never reads as "browsing lost them".
    await expect(page.getByText(/1 seat held in your basket/)).toBeVisible();
  });
});
