import { test, expect } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * Payments by market on the organizer dashboard, as the admin dashboard shows them.
 *
 * Reported by the owner: "On organizer side still I don't see country by payments, I can see on
 * Admin side". The admin overview lists every market — country and currency — with its money,
 * bookings and payment failures. The organizer's dashboard named a country only in a heading,
 * and only for a market that had already taken money.
 */
test.describe('organizer dashboard: payments by market', () => {
  let owner: AuthTokens;

  test.beforeAll(async ({ request }) => {
    owner = await apiLogin(request, 'owner@eticketsgo.test');
  });

  test('1: the API lists each market once, with its payments', async ({ request }) => {
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
    const org = (Array.isArray(orgs) ? orgs : orgs.data)[0];
    const res = await request.get(`${API}/analytics/organizer?organizationId=${org.id}`, {
      headers: auth,
    });
    expect(res.ok()).toBe(true);
    const { markets } = (await res.json()) as {
      markets: {
        currency: string;
        paidBookings: number;
        totalBookings: number;
      }[];
    };

    expect(Array.isArray(markets)).toBe(true);
    expect(markets.length).toBeGreaterThan(0);
    for (const market of markets) {
      expect(market).toEqual(
        expect.objectContaining({
          currency: expect.stringMatching(/^[A-Z]{3}$/),
          grossMinor: expect.any(Number),
          netMinor: expect.any(Number),
          refundsMinor: expect.any(Number),
          paidBookings: expect.any(Number),
          totalBookings: expect.any(Number),
          paymentFailures: expect.any(Number),
        }),
      );
      // A paid booking is a booking: the count of all of them can never be the smaller.
      expect(market.totalBookings).toBeGreaterThanOrEqual(market.paidBookings);
    }
    // One row per currency — a market is never listed twice.
    expect(new Set(markets.map((m) => m.currency)).size).toBe(markets.length);
  });

  test('2: the dashboard shows every market by country, with its payment failures', async ({
    page,
    context,
  }) => {
    await seedBrowserAuth(context, owner);
    await page.goto(`${ORGANIZER}/organizer`);

    await expect(page.getByText('By market', { exact: true })).toBeVisible({ timeout: 30_000 });
    const table = page.getByRole('table', { name: /each market/ });
    await expect(table).toBeVisible();
    for (const column of [
      'Market',
      'Gross sales',
      'Net revenue',
      'Refunds',
      'Paid bookings',
      'All bookings',
      'Payment failures',
    ]) {
      await expect(table.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }

    const markets = table.getByRole('rowheader');
    expect(await markets.count()).toBeGreaterThan(0);
    // "India · INR" — the country first, as the admin dashboard names it, not a bare code.
    await expect(markets.first()).toHaveText(/^\S.* · [A-Z]{3}$/);
  });
});
