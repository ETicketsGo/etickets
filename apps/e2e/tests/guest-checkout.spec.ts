import { test, expect } from '@playwright/test';
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

    bookingUrl = page.url();
    const body = await page.locator('body').innerText();
    reference = /ETG-[A-Z]+-\d{4}-\d+/.exec(body)?.[0] ?? '';
    expect(reference, 'the confirmation shows a booking reference').not.toBe('');
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
});
