import { test, expect } from '@playwright/test';
import { CUSTOMER, SEED_PASSWORD, uniqueEmail } from './helpers';

test('customer books a movie seat and pays', async ({ page }) => {
  // Register
  await page.goto(`${CUSTOMER}/register`);
  await page.getByLabel('Full name').fill('E2E Movie Fan');
  await page.getByLabel('Email').fill(uniqueEmail('movie'));
  await page.getByLabel(/Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/, { timeout: 20_000 });

  // Movie discovery renders
  await page.goto(`${CUSTOMER}/movies`);
  await expect(page.locator('a[href^="/movies/"]').first()).toBeVisible();

  // Open the seeded bookable movie and pick a showtime
  await page.goto(`${CUSTOMER}/movies/skyfront-protocol`);
  const showtime = page.locator('a[href^="/shows/"]').first();
  await expect(showtime).toBeVisible({ timeout: 20_000 });
  await showtime.click();
  await expect(page).toHaveURL(/\/shows\/.+/);

  // Select the first available seat, remembering WHICH one — the checkout has to name it.
  const seat = page.locator('button[aria-label^="Seat"][aria-label*="available" i]').first();
  await expect(seat).toBeVisible({ timeout: 20_000 });
  const seatAria = (await seat.getAttribute('aria-label')) ?? '';
  /*
    The accessible name carries the ROW as well as the number — "Seat A1", not "Seat 1".
    That was a defect this test found: without the row, every row's first seat announced
    identically to a screen reader, and the two were indistinguishable.
  */
  const chosen = /Seat\s+([A-Z]+\d+)/i.exec(seatAria)?.[1] ?? '';
  expect(chosen, `expected a row-qualified seat name, got "${seatAria}"`).not.toBe('');
  await seat.click();

  // The summary panel must name the ROW, not just the number. It listed "11, 12" and left
  // the buyer to work out which row from a map they had clicked away from.
  await expect(page.getByText(chosen, { exact: false }).first()).toBeVisible({ timeout: 10_000 });

  /*
    The full price, on THIS screen.

    It used to show a ticket subtotal and the words "transparent fees shown on the next
    step" — so the number the buyer actually pays first appeared after they had committed to
    seats. The quote holds nothing, so it can be shown before anything is reserved.
  */
  const breakdown = page.getByTestId('price-breakdown');
  await expect(breakdown).toBeVisible({ timeout: 20_000 });
  await expect(breakdown.getByText('Tickets')).toBeVisible();
  await expect(breakdown.getByText('Booking fee')).toBeVisible();
  await expect(page.getByText(/full amount you will pay/i)).toBeVisible();

  // A code box lives here too, and a private code is typed rather than listed.
  const seatCode = page.getByLabel('Discount code');
  await expect(seatCode).toBeVisible();
  await seatCode.fill('DEFINITELY-NOT-A-CODE');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 });

  // Proceed to the (shared) payment flow
  await page.getByRole('button', { name: /Proceed to pay/i }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });

  /*
    Reported from QA: this screen showed "2 x A" — a count and a ticket-type name — and never
    said which seats were being bought. For reserved seating that is the one detail the buyer
    is checking, and the last moment a mistake is free to fix.
  */
  await expect(page.getByText(/^Seats?$/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(chosen, { exact: false })).toBeVisible();

  /*
    Somewhere to put a discount code.

    Reported from QA: an organizer created a promotion and found nowhere in the buying flow
    to use it. The API had always accepted one — but only at booking CREATION, while the
    buyer is picking seats rather than looking at a total.
  */
  const codeBox = page.getByLabel('Discount code');
  await expect(codeBox).toBeVisible();
  await codeBox.fill('DEFINITELY-NOT-A-CODE');
  await page.getByRole('button', { name: 'Apply' }).click();
  // A box that accepts anything and changes nothing would be worse than one that says no.
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: /Pay/ }).click();

  // Confirmation
  await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });

  /*
    The ticket itself, without a second click.

    The QR is what the buyer came for and what the door scans; putting it one navigation away
    from a page they have already reached earns nothing.
  */
  const qr = page.getByRole('img', { name: /Entry QR code/i }).first();
  await expect(qr).toBeVisible({ timeout: 30_000 });
  await expect(qr).toHaveAttribute('src', /^data:image\//);
  // And the seat is named on it, so the buyer knows where to sit without opening anything.
  await expect(page.getByText(chosen, { exact: false }).first()).toBeVisible();
});
