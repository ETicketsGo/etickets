import { test, expect } from '@playwright/test';
import { QA_VALIDATE, QA_SKIP_REASON } from './qa-target';
import { apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

// Deployment-facing: skipped unless asked for. See qa-target.ts for why.
test.skip(!QA_VALIDATE, QA_SKIP_REASON);

/**
 * An organizer's promotion has to be findable by the person buying the ticket.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * Checkout had a discount box, so the feature looked done — but it was a blank field. It
 * only helped a buyer who already knew the code. QA has had a live `FIRST10 — 10% off`
 * advertised on its sessions the whole time and nothing in the buying flow said so.
 *
 * The seat-picking screen HAS listed available offers for a while. General-admission
 * events never pass through a seat map, so for most of what this platform sells the list
 * simply did not exist — the same "built on one screen, never brought to the other" shape
 * as the price breakdown.
 */
const CUSTOMER = 'https://customer-web-qa.up.railway.app';
const API = 'https://api-qa-f580.up.railway.app/api';

let tokens: AuthTokens;
test.beforeAll(async ({ request }) => {
  test.skip(!QA_VALIDATE, QA_SKIP_REASON);
  tokens = await apiLogin(request, 'customer1@eticketsgo.test');
});

test('the offers an organizer advertises are offered at checkout', async ({
  page,
  context,
  request,
}) => {
  // A session that actually advertises something, so a pass means the list works rather
  // than that there was nothing to list.
  const list = await (await request.get(`${API}/public/events?pageSize=50`)).json();
  let target: { slug: string; sessionId: string; code: string } | null = null;
  for (const e of list.data ?? list) {
    if ((e.fromPriceMinor ?? 0) <= 0) continue;
    const detail = await (await request.get(`${API}/public/events/${e.slug}`)).json();
    for (const s of detail.sessions ?? []) {
      if (s.seatBased || !(s.ticketTypes ?? []).length) continue;
      const offers = await (await request.get(`${API}/bookings/offers/${s.id}`)).json();
      if (Array.isArray(offers) && offers.length) {
        target = { slug: e.slug, sessionId: s.id, code: offers[0].code };
        break;
      }
    }
    if (target) break;
  }
  expect(target, 'QA needs a paid GA session with an advertised offer').toBeTruthy();

  await seedBrowserAuth(context, tokens);
  await page.goto(`${CUSTOMER}/events/${target!.slug}`, { waitUntil: 'networkidle' });
  await page
    .getByRole('combobox', { name: /^Quantity of / })
    .first()
    .selectOption('1');
  await page.getByRole('button', { name: /Continue to payment/i }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 40_000 });

  // The organizer's code is on the screen, not something the buyer had to be told.
  const offers = page.getByRole('combobox', { name: /Available offers/i });
  await expect(offers).toBeVisible({ timeout: 30_000 });
  await expect(offers).toContainText(target!.code);

  /*
    And choosing it actually re-prices. A list that names a discount without applying one
    is a worse lie than no list: the buyer believes they got it.
  */
  const before = await page
    .getByText(/Total payable|Total/)
    .first()
    .innerText();
  await offers.selectOption(target!.code);
  await expect(page.getByText(/Discount code applied|Discount applied/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/^-\s?[₹$]/)).toBeVisible();
  expect(before).toBeTruthy();
});
