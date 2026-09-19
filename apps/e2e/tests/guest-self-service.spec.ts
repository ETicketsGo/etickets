import { test, expect } from '@playwright/test';
import { API, CUSTOMER, SEED_PASSWORD, apiLogin, uniqueEmail } from './helpers';
import { openPaidEvent } from './pick-event';

/**
 * What a guest can do about a booking after they have paid for it.
 *
 * ── WHY THE INVOICE AND THE REFUND ARE NOT DRIVEN THROUGH THE BROWSER HERE ─────────
 * Both need the access token, and the only place that token exists is inside the email. A test
 * has no inbox, and the alternative -- a route that hands a token to a caller who asks -- is
 * exactly the door this feature is built to keep shut. Their happy paths are covered by the
 * API's own integration tests, where the token is reachable legitimately. What is proven here
 * is the half a browser can prove: the claim, end to end, and that both money routes refuse a
 * link they have never issued.
 */

const guest = { name: 'E2E Claim Buyer', email: uniqueEmail('claim') };

/** Buys one ticket as a guest and returns the confirmation URL and the booking id. */
async function buyAsGuest(page: import('@playwright/test').Page) {
  await page.goto(`${CUSTOMER}/events`);
  await openPaidEvent(page);

  const quantity = page.locator('select[aria-label^="Quantity"]').first();
  await expect(quantity).toBeVisible({ timeout: 20_000 });
  await quantity.selectOption('1');

  await page.getByLabel('Your name').fill(guest.name);
  await page.getByLabel('Email', { exact: true }).fill(guest.email);
  await page.getByRole('button', { name: /Continue to payment/ }).click();

  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
  await page.getByRole('button', { name: /^Pay/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });
  await expect(page.getByRole('img', { name: /Entry QR code/i }).first()).toBeVisible({
    timeout: 30_000,
  });

  const url = page.url();
  return { url, id: /\/booking\/([^/]+)\/confirmation/.exec(url)?.[1] ?? '' };
}

test.describe('a guest keeps their booking', () => {
  test('1: signing in from the confirmation moves the booking into that account', async ({
    page,
    request,
  }) => {
    const booking = await buyAsGuest(page);
    expect(booking.id).not.toBe('');

    /*
      The offer is made where somebody has just paid and is most likely to want it. Signing in
      navigates away, so the point of the test is that it comes BACK and finishes the job --
      that round trip is where an earlier draft of this flow lost the booking.
    */
    await expect(page.getByText('Save this booking to my account')).toBeVisible();
    // A button, not a link: it records which booking to finish claiming before it navigates.
    await page.getByRole('button', { name: 'Sign in and save it' }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });

    await page.getByRole('tab', { name: 'Email' }).click();
    await page.getByLabel('Email', { exact: true }).fill('customer1@eticketsgo.test');
    await page.getByLabel(/Password/).fill(SEED_PASSWORD);
    await page.getByRole('button', { name: /Sign in/ }).click();

    await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 30_000 });
    await expect(page.getByText('This booking is now in your account')).toBeVisible({
      timeout: 30_000,
    });

    // It is an ordinary account booking now, so the guest door is shut on it.
    const asGuest = await request.get(`${API}/bookings/guest/${booking.id}`, {
      headers: { 'x-anon-session': `anon_${'a'.repeat(43)}` },
    });
    expect(asGuest.status()).toBe(404);

    // And the account it went into can read it.
    const tokens = await apiLogin(request, 'customer1@eticketsgo.test');
    const mine = await request.get(`${API}/bookings/${booking.id}`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(mine.status()).toBe(200);
    expect((await mine.json()).id).toBe(booking.id);
  });

  test('2: claiming again changes nothing, and never takes it from its owner', async ({
    request,
  }) => {
    const mine = await apiLogin(request, 'customer1@eticketsgo.test');
    const booked = await request.get(`${API}/bookings?pageSize=1`, {
      headers: { Authorization: `Bearer ${mine.accessToken}` },
    });
    const rows = await booked.json();
    const id = (Array.isArray(rows) ? rows : (rows?.data ?? []))[0]?.id;
    test.skip(!id, 'customer1 holds no booking in this environment');

    // A second account, holding nothing but a guess at the id, must not be able to take it.
    const other = await apiLogin(request, 'customer2@eticketsgo.test');
    const stolen = await request.post(`${API}/bookings/guest/${id}/claim`, {
      headers: {
        Authorization: `Bearer ${other.accessToken}`,
        'x-anon-session': `anon_${'b'.repeat(43)}`,
      },
      data: {},
    });
    expect([403, 409]).toContain(stolen.status());
  });

  test('3: the money routes refuse a link nobody was ever sent', async ({ request }) => {
    const token = 'not-a-real-access-token-value-at-all';
    const invoice = await request.post(`${API}/bookings/guest/access/${token}/receipt`, {
      data: { email: guest.email },
    });
    const refund = await request.post(`${API}/bookings/guest/access/${token}/refund`, {
      data: { email: guest.email },
    });

    // 404 on both, and the same 404: a dead link must not say whether it was ever real.
    expect(invoice.status()).toBe(404);
    expect(refund.status()).toBe(404);
  });

  test('4: claiming needs an account, not just the booking id', async ({ request }) => {
    const anonymous = await request.post(`${API}/bookings/guest/cmzzzzzzzzzzzzzzzzzzzzzzz/claim`, {
      data: {},
    });
    expect(anonymous.status()).toBe(401);
  });
});
