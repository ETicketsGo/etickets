import { test, expect } from '@playwright/test';

/**
 * Buying a ticket through a venue map, on QA, all the way to the QR code.
 *
 * The pieces are each proven elsewhere: the map renders, a block opens, the seat grid works,
 * checkout names the seat. What no other test covers is the join — that a seat chosen behind
 * a two-step read reaches the booking, the payment screen and the ticket with the same
 * identity it had on the map.
 *
 * That join is where a sectioned venue could plausibly break and a cinema could not: the
 * seat comes from a payload the page fetched separately, held in state the page accumulated
 * rather than in the response it is rendering.
 *
 * Set QA_ARENA_SESSION to a show scheduled on a sectioned layout in QA.
 */
const CUSTOMER = 'https://customer-web-qa.up.railway.app';
const PW = 'Password123!';
const SESSION_ID = process.env.QA_ARENA_SESSION ?? '';

const uniqueEmail = () => `venue_${Date.now()}_${Math.floor(Math.random() * 1000)}@e2e.test`;

test.describe('QA: buying a seat off a venue map', () => {
  test.skip(!SESSION_ID, 'set QA_ARENA_SESSION to an arena show on QA');

  test('map to block to seat to QR code', async ({ page }) => {
    await page.goto(`${CUSTOMER}/register`, { waitUntil: 'networkidle' });
    await page.getByLabel('Full name').fill('QA Venue Buyer');
    await page.getByLabel('Email').fill(uniqueEmail());
    await page.getByLabel(/Password/).fill(PW);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/account\/tickets/, { timeout: 40_000 });

    await page.goto(`${CUSTOMER}/shows/${SESSION_ID}`, { waitUntil: 'networkidle' });

    // 1. The map, not a wall of seats.
    await expect(page.getByRole('heading', { name: 'Choose your area' })).toBeVisible();
    await page.getByRole('button', { name: /^Floor A,/ }).click();

    // 2. One block's seats.
    await expect(page.getByRole('heading', { name: 'Floor A' })).toBeVisible();
    const seat = page.locator('button[aria-label^="Seat"][aria-label*="available" i]').first();
    await expect(seat).toBeVisible({ timeout: 30_000 });
    const chosen = /Seat\s+([A-Z]+\d+)/i.exec((await seat.getAttribute('aria-label')) ?? '')?.[1];
    expect(chosen, 'the seat should be named with its row').toBeTruthy();
    await seat.click();

    // 3. Priced here, before committing — same as a cinema.
    const breakdown = page.getByTestId('price-breakdown');
    await expect(breakdown).toBeVisible({ timeout: 30_000 });
    await expect(breakdown.getByText('Tickets')).toBeVisible();

    await page.getByRole('button', { name: /Proceed to pay/i }).click();
    await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 40_000 });

    /*
      The seat survives the journey with its name intact.

      This is the assertion the whole file exists for. The seat came from a per-block payload
      that is no longer on screen; if the page derived its basket from what it is currently
      rendering, the booking would carry an id and no label, and the buyer would be paying
      for "a seat" with no idea which.
    */
    await expect(page.getByText(/^Seats?$/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(chosen!, { exact: false })).toBeVisible();

    await page.getByRole('button', { name: /Pay/ }).click();
    await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 40_000 });

    // 4. The ticket, with the seat on it, without a second click.
    const qr = page.getByRole('img', { name: /Entry QR code/i }).first();
    await expect(qr).toBeVisible({ timeout: 40_000 });
    await expect(qr).toHaveAttribute('src', /^data:image\//);
    await expect(page.getByText(chosen!, { exact: false }).first()).toBeVisible();
  });

  test('the seat it sold is no longer on offer', async ({ page }) => {
    /*
      Inventory has to move on the OVERVIEW too, not only in the block.

      The overview's availability comes from a grouped SQL count and the block's from Prisma
      rows — two paths to the same number, which is exactly how a block comes to advertise
      forty free seats and offer thirty-nine. A real-Postgres test checks them against each
      other; this checks the customer actually sees it.
    */
    await page.goto(`${CUSTOMER}/shows/${SESSION_ID}`, { waitUntil: 'networkidle' });
    const label =
      (await page.getByRole('button', { name: /^Floor A,/ }).getAttribute('aria-label')) ?? '';
    const [, available, total] = /(\d+) of (\d+) seats available/.exec(label) ?? [];
    expect(available, 'the map should say how many are left').toBeTruthy();
    // The previous test bought one, so the block is no longer untouched.
    expect(Number(available)).toBeLessThan(Number(total));
  });
});
