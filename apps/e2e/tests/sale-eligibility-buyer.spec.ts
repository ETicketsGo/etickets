import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, CUSTOMER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * A show that cannot be sold online, as the buyer meets it.
 *
 * Found on QA (2026-10-09): every checkout for a Hyderabad cinema was refused with a 409
 * because its state has no ticket price rules yet. The buyer could still pick seats; pressing
 * "Proceed to pay" seemed to do nothing, because the reason was a toast that was gone in a few
 * seconds.
 *
 * The seeded data has no such show and must not be given one (no state rules may be added or
 * activated by a test), so the two server answers are put in flight instead: the public show
 * summary saying the show is closed, and the booking call refusing with the reason the API
 * really sends. What is under test is what the page does with them.
 */

const BUYER_SENTENCE =
  'Online booking is not open for this show yet. Please check back later or contact the venue.';

interface Seat {
  id: string;
  label: string;
  status: string;
  kind: string;
}

/** A screening of the seeded film with one free, ordinary seat. */
async function showWithAFreeSeat(request: APIRequestContext) {
  const { shows } = await (
    await request.get(`${API}/public/movies/skyfront-protocol/shows?limit=200`)
  ).json();
  for (const show of shows as { sessionId: string; seatingType: string; availability: string }[]) {
    if (show.seatingType !== 'RESERVED') continue;
    if (show.availability === 'SOLD_OUT' || show.availability === 'SALES_PAUSED') continue;
    const layout = await (await request.get(`${API}/public/shows/${show.sessionId}/seats`)).json();
    if (layout.view !== 'seats') continue;
    for (const section of layout.sections as { rows: { label: string; seats: Seat[] }[] }[]) {
      for (const row of section.rows) {
        const free = row.seats.find(
          (s) => s.status === 'AVAILABLE' && s.kind !== 'WHEELCHAIR' && s.kind !== 'COMPANION',
        );
        if (free) return { sessionId: show.sessionId, seat: `${row.label}${free.label}` };
      }
    }
  }
  throw new Error('No screening of skyfront-protocol has a free seat.');
}

const seat = (page: Page, name: string) => page.locator(`button[aria-label^="Seat ${name},"]`);

test.describe('a show that cannot be sold online', () => {
  // A `route.fetch()` below can still be waiting on the API when the test ends; without this its
  // rejection fails whichever test the worker runs next (see cinema-workspace.spec.ts).
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  let show: Awaited<ReturnType<typeof showWithAFreeSeat>>;

  test.beforeAll(async ({ request }) => {
    show = await showWithAFreeSeat(request);
  });

  test('1: the page says so before a seat is picked, and nothing can be picked', async ({
    page,
  }) => {
    await page.route(`**/public/shows/${show.sessionId}`, async (route) => {
      const response = await route.fetch();
      const summary = await response.json();
      summary.onlineBooking = { open: false, message: BUYER_SENTENCE, closedTicketTypeIds: [] };
      await route.fulfill({ response, json: summary });
    });

    await page.goto(`${CUSTOMER}/shows/${show.sessionId}`);
    const notice = page.getByTestId('sales-closed');
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(notice).toContainText(BUYER_SENTENCE);
    // Plain words only: nothing about the regulation, the state or an internal code.
    await expect(notice).not.toContainText(/regulat|Telangana|polic|SALE_NOT_OPEN/i);

    // The room is still shown, but every seat in it is unavailable and cannot be chosen.
    await expect(seat(page, show.seat)).toBeDisabled();
    await expect(seat(page, show.seat)).toHaveAttribute('aria-label', /unavailable/);
    await expect(page.locator('button[aria-label^="Seat "]:enabled')).toHaveCount(0);
    // And there is nothing to pay for.
    await expect(page.getByRole('button', { name: /Proceed to pay/i })).toBeDisabled();
  });

  test('2: a refusal at checkout stays on screen, beside the button', async ({
    page,
    context,
    request,
  }) => {
    await seedBrowserAuth(context, await apiLogin(request, 'customer1@eticketsgo.test'));
    // The answer the API gives today for a Telangana show, verbatim in shape.
    await page.route('**/api/bookings', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 409,
        json: {
          code: 'VALIDATION_FAILED',
          message: BUYER_SENTENCE,
          details: { reason: 'SALE_NOT_OPEN', blockers: ['NO_PRICING_POLICY'] },
        },
      });
    });

    await page.goto(`${CUSTOMER}/shows/${show.sessionId}`);
    await expect(seat(page, show.seat)).toBeEnabled({ timeout: 20_000 });
    await seat(page, show.seat).click();
    await page.getByRole('button', { name: /Proceed to pay/i }).click();

    const alert = page.getByTestId('booking-error');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toHaveText(BUYER_SENTENCE);
    // Still there after any toast would have gone: this is the whole point.
    await page.waitForTimeout(6_000);
    await expect(alert).toBeVisible();
    // And the page now knows the show is closed, so the seats close too.
    await expect(page.getByTestId('sales-closed')).toBeVisible();
    await expect(page.getByRole('button', { name: /Proceed to pay/i })).toBeDisabled();
  });
});
