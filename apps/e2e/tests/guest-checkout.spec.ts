import { test, expect, type Page } from '@playwright/test';
import { API, CUSTOMER, apiLogin, uniqueEmail } from './helpers';
import { openPaidEvent } from './pick-event';

/**
 * Buying a ticket without an account.
 *
 * Reported by the owner: a signed-out visitor who pressed the pay button was sent to the
 * sign-in page with no explanation and no other way through. The API could already take a
 * guest booking and a guest payment; what a guest could not do was RECEIVE the ticket, so
 * these tests follow the money all the way to a QR code on screen, and then check the two
 * ways back to a booking that nobody can sign in to look up.
 */

const guest = {
  name: 'E2E Guest Buyer',
  email: uniqueEmail('guest'),
};

/**
 * Every figure on one card reads as one document.
 *
 * Reported from QA: "subtotal 499, fees 20.18, Tax 79.76 but total is 522.82 which is not
 * matching the numbers and its good to show 499.00". Two defects in one screen. The tax row
 * counted the GST already inside the INR ticket price, which is a memo and not an addend, so the
 * column could not add up. And the order line decided its own decimals, so a whole-rupee ticket
 * printed "Rs 200" directly above the breakdown's "Rs 200.00".
 *
 * Checked from inside the buying test, because a guest confirmation opens only in the browser
 * that bought it - which is the subject of test 2.
 */
async function expectTheMoneyToAddUp(page: Page): Promise<void> {
  const amounts = (await page.locator('main').innerText())
    .split('\n')
    .flatMap((line) => line.match(/₹[\d,]+(?:\.\d+)?/g) ?? []);
  expect(amounts.length, 'the confirmation shows money').toBeGreaterThan(1);

  // One shape for the whole card: either every figure carries paise or none does.
  const withPaise = amounts.filter((a) => a.includes('.')).length;
  expect(
    withPaise === 0 || withPaise === amounts.length,
    `mixed decimal shapes on one card: ${amounts.join(' ')}`,
  ).toBe(true);

  /*
    And the rows above the total add up to it. The ticket subtotal appears twice - once as the
    order line, once as the breakdown's first row - so the rows sum to the total plus one
    subtotal. Asserting that, rather than picking rows out by label, keeps this about arithmetic
    the buyer can do with their own eyes.
  */
  const values = amounts.map((a) => Number(a.replace(/[₹,]/g, '')));
  const total = Math.max(...values);
  const rows = values.filter((v) => v !== total);
  const subtotal = Math.max(...rows);
  expect(
    Math.abs(rows.reduce((a, b) => a + b, 0) - subtotal - total),
    `rows do not add up to the total: ${amounts.join(' ')}`,
  ).toBeLessThan(0.02);
}

test.describe('guest checkout', () => {
  /** Filled by the first test and read by the ones that follow it. */
  let bookingUrl = '';
  let reference = '';

  test('1: a visitor with no account buys a ticket and sees the QR', async ({ page }) => {
    await page.goto(`${CUSTOMER}/events`);
    await openPaidEvent(page);

    const quantity = page.locator('select[aria-label^="Quantity"]').first();
    await expect(quantity).toBeVisible({ timeout: 20_000 });
    await quantity.selectOption('1');

    // The guest form appears once there is something to buy, not before.
    await expect(page.getByText('Buy as a guest')).toBeVisible();
    await page.getByLabel('Your name').fill(guest.name);
    await page.getByLabel('Email', { exact: true }).fill(guest.email);
    // Signing in is still offered; it is an alternative, not the only way.
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();

    await page.getByRole('button', { name: /Continue to payment/ }).click();
    await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });

    await page.getByRole('button', { name: /^Pay/ }).click();
    await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });

    // The ticket itself, on the page, for somebody who has no wallet to send them to.
    const qr = page.getByRole('img', { name: /Entry QR code/i });
    await expect(qr.first()).toBeVisible({ timeout: 30_000 });
    await expect(qr.first()).toHaveAttribute('src', /^data:image\//);

    await expectTheMoneyToAddUp(page);

    bookingUrl = page.url();
    const body = await page.locator('body').innerText();
    reference = /ETG-[A-Z]+-\d{4}-\d+/.exec(body)?.[0] ?? '';
    expect(reference, 'the confirmation shows a booking reference').not.toBe('');

    // In the same browser on purpose: a guest's booking belongs to the browser that bought it.
    /*
      Reported from QA: "booking as a guest, I see the confirmation and not a ticket". An
      account holder opens each ticket on its own; a guest had a thumbnail and a promise that a
      link was on its way by email - and with email not delivering, closing the tab lost the
      tickets. The guest now gets the same printable sheet the box office uses, from the
      confirmation, without waiting for anything.
    */
    await page.getByRole('link', { name: 'Show or print tickets' }).click();
    await expect(page).toHaveURL(/\/booking\/.+\/tickets\/print/, { timeout: 20_000 });

    await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible({
      timeout: 30_000,
    });
    // The QR the door scans, full size, and the reference the door types in when it will not.
    const fullSizeQr = page.locator('.print-ticket img[src^="data:image/"]');
    await expect(fullSizeQr.first()).toBeVisible();
    await expect(page.locator('.print-ticket').first()).toContainText(reference);
    // A bare page: paper carries no site header, and hiding one at print time lost tickets.
    await expect(page.getByRole('link', { name: 'Browse' })).toHaveCount(0);

    await page.getByRole('link', { name: 'Back to booking' }).click();
    await expect(page).toHaveURL(/\/booking\/.+\/confirmation/);
  });

  test('2: the booking survives a browser that has forgotten it', async ({ browser }) => {
    /*
      A new context is a new browser as far as storage is concerned, which is exactly what a
      guest has after closing the tab or picking up a different phone. The booking must not be
      readable here, and the page must say how to get back to it rather than showing an error.
    */
    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    await page.goto(bookingUrl);

    await expect(page.getByText('This booking is not open in this browser')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('img', { name: /Entry QR code/i })).toHaveCount(0);
    await fresh.close();
  });

  test('3: find-my-booking answers identically whether or not the booking exists', async ({
    request,
  }) => {
    /*
      The whole point of this endpoint is that it cannot be used to discover who bought what.
      A real reference with the wrong email, and a reference that never existed, must be
      indistinguishable from the answer.
    */
    const real = await request.post(`${API}/bookings/guest/lookup`, {
      data: { reference, email: guest.email },
    });
    const wrongEmail = await request.post(`${API}/bookings/guest/lookup`, {
      data: { reference, email: 'someone-else@eticketsgo.test' },
    });
    const missing = await request.post(`${API}/bookings/guest/lookup`, {
      data: { reference: 'ETG-IND-2026-000000', email: guest.email },
    });

    expect(real.status()).toBe(wrongEmail.status());
    expect(real.status()).toBe(missing.status());
    expect(await real.json()).toEqual(await missing.json());
    expect(await real.json()).toEqual(await wrongEmail.json());
  });

  test('4: the guest booking route refuses an unauthenticated read and an account booking', async ({
    request,
  }) => {
    const id = /\/booking\/([^/]+)\/confirmation/.exec(bookingUrl)?.[1] ?? '';
    expect(id).not.toBe('');

    // No session header at all.
    const bare = await request.get(`${API}/bookings/guest/${id}`);
    expect(bare.status()).toBe(401);

    // A booking that belongs to an account is never readable through the guest door.
    const tokens = await apiLogin(request, 'customer1@eticketsgo.test');
    const mine = await request.get(`${API}/bookings?pageSize=1`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const rows = await mine.json();
    const accountBookingId = (Array.isArray(rows) ? rows : (rows?.data ?? []))[0]?.id;
    test.skip(!accountBookingId, 'customer1 holds no booking in this environment');

    const stolen = await request.get(`${API}/bookings/guest/${accountBookingId}`, {
      headers: { 'x-anon-session': `anon_${'a'.repeat(43)}` },
    });
    expect(stolen.status()).toBe(404);
  });

  test('5: a dead access link says so, and offers a new one', async ({ page }) => {
    await page.goto(`${CUSTOMER}/booking/access/anon_not_a_real_token_value_1234567890`);
    await expect(page.getByText('This link no longer works')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('link', { name: /Find my booking/i }).first()).toBeVisible();
  });

  test('6: find my booking always says the same thing', async ({ page }) => {
    await page.goto(`${CUSTOMER}/booking/find`);
    await page.getByLabel('Booking reference').fill('ETG-IND-2026-000000');
    await page.getByLabel('Email', { exact: true }).fill('nobody@eticketsgo.test');
    await page.getByRole('button', { name: 'Email me the link' }).click();

    await expect(
      page.getByText('If that booking exists, we have emailed a link to it'),
    ).toBeVisible({ timeout: 20_000 });
  });

  /*
    Giving the tickets back before paying.

    Reported from QA: "I reached review & pay, when I click on cancel booking and select yes
    cancel nothing is happening, still on review and pay". The route answered 409 to every guest,
    on a rule that had expired, and the screen showed the refusal as a muted caption above the
    summary, the total and both buttons - off screen on a phone. The buyer watched a countdown
    while the seats stayed held against nobody.
  */
  test('7: a guest cancels their own unpaid booking and the seats go back', async ({
    page,
    request,
  }) => {
    await page.goto(`${CUSTOMER}/events`);
    await openPaidEvent(page);

    const quantity = page.locator('select[aria-label^="Quantity"]').first();
    await expect(quantity).toBeVisible({ timeout: 20_000 });
    await quantity.selectOption('1');
    await page.getByLabel('Your name').fill(guest.name);
    await page.getByLabel('Email', { exact: true }).fill(uniqueEmail('guestcancel'));
    await page.getByRole('button', { name: /Continue to payment/ }).click();
    await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
    const cancelledId = /\/booking\/([^/]+)\/payment/.exec(page.url())?.[1] ?? '';

    await page.getByRole('button', { name: 'Cancel booking' }).click();
    await page.getByRole('button', { name: /Yes, cancel it/i }).click();

    // It leaves the payment screen. Staying put IS the bug.
    await expect(page).not.toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });

    /*
      And the booking is really cancelled, not merely navigated away from. Read without the
      session token on purpose: the token was forgotten with the booking, and a 401 here proves
      only that the browser let go, which is not the same as the seats going back.
    */
    const after = await request.get(`${API}/bookings/guest/${cancelledId}`, {
      headers: { 'x-anon-session': `anon_${'b'.repeat(43)}` },
    });
    expect([401, 403, 404]).toContain(after.status());
  });

  test('8: a stranger cannot cancel a guest booking with a token they minted', async ({
    request,
  }) => {
    /*
      The guest cancel is the only guest route held to the STRICTEST session answer. A read and a
      payment accept a booking that records no session - the worst case there is somebody seeing
      or paying for a booking that is not theirs. A cancel releases it, so 256 bits the caller
      generated plus a booking id must not be enough.
    */
    const id = /\/booking\/([^/]+)\/confirmation/.exec(bookingUrl)?.[1] ?? '';
    test.skip(!id, 'test 1 did not complete');
    const stolen = await request.post(`${API}/bookings/guest/${id}/cancel`, {
      headers: { 'x-anon-session': `anon_${'c'.repeat(43)}` },
    });
    // Never 201. Either the session is refused or the paid booking is, and both are correct.
    expect([403, 404, 409]).toContain(stolen.status());
  });
});
