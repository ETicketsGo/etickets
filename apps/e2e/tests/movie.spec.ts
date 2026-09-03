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
  /*
    ONE row for what the platform charges, not three.

    This asserted 'Booking fee', which was one of three rows — booking fee, payment fee, and
    the tax charged on them. None of those three answers the question the buyer is asking,
    and adding them up was work being handed to the customer. The row is now "Platform fee",
    with the tax rate named in the label when there is one.
  */
  await expect(breakdown.getByText(/Platform fee/)).toBeVisible();
  await expect(breakdown.getByText(/Booking fee|Payment fee/)).toHaveCount(0);

  /*
    And the rows FOOT. This is the guarantee worth pinning: whatever the breakdown chooses
    to show, the numbers a buyer can see must add up to the total they are asked to pay. A
    label assertion alone would survive a fee row that quietly disagreed with the total.

    Each row renders as "<label><tab><amount>", so the amount is the LAST number on the
    line and cannot be found by stripping non-digits — "Platform fee (incl. 18% GST)" would
    otherwise contribute an 18. A discount row carries a leading "-" and has to subtract,
    or this would hold only for carts that happen to have no discount.
  */
  const trailingAmount = (line: string): number | null => {
    // INR renders with maximumFractionDigits: 0 ("₹300"), everything else with two
    // ("$300.00"), so the decimals are optional. Requiring them found nothing at all —
    // which the length guard below caught rather than letting a sum of zero pass.
    const match = /(-?)\s*[^0-9-]*?([\d,]+(?:\.\d{2})?)\s*$/.exec(line.trim());
    return match ? Number(match[2].replace(/,/g, '')) * (match[1] === '-' ? -1 : 1) : null;
  };

  const visible = (await breakdown.innerText())
    .split('\n')
    .map(trailingAmount)
    .filter((n): n is number => n !== null);
  const total = trailingAmount(await page.getByTestId('price-total').innerText());

  expect(visible.length).toBeGreaterThan(1);
  expect(total).not.toBeNull();
  /*
    Tolerance of one unit per row, because INR is displayed rounded to whole rupees: a row
    holding ₹55.22 prints "₹55", so the printed rows can differ from the printed total by
    less than a rupee each. Anything larger is a row that genuinely disagrees.
  */
  expect(Math.abs(visible.reduce((a, b) => a + b, 0) - total!)).toBeLessThanOrEqual(visible.length);

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
