import { expect, type Page } from '@playwright/test';

/**
 * Open an event that actually charges for a ticket, and sells it by the ticket.
 *
 * ── WHY NOT JUST THE FIRST ONE ─────────────────────────────────────────────────────
 * These suites used to click `a[href^="/events/"]`.first() and then look for "Continue to
 * payment". That worked only because every seeded event happened to be paid. The moment a
 * free one was seeded, whichever event sorted first decided whether four unrelated tests
 * passed — and a free event's button says "Get my tickets", because there is no payment
 * step to continue to.
 *
 * ── AND WHY NOT JUST A PAID ONE ────────────────────────────────────────────────────
 * The same rot, one step further along. Reserved seating is no longer a cinema feature: any
 * event can be sold from a seat map, and a seated event has no quantity picker at all — it
 * sends the buyer to the map to choose seats instead. So once a seated event sorted first,
 * five tests failed on a missing `select[aria-label^="Quantity"]`, none of which were about
 * seating.
 *
 * Every caller of this helper goes straight on to that quantity picker. So that is what it
 * promises: a paid event, sold by quantity, open and ready to buy from. Seat-map buying has
 * its own suites, which pick their own fixtures for the same reason.
 */
export async function openPaidEvent(page: Page): Promise<void> {
  const listing = page.url();
  const cards = page.locator('a[href^="/events/"]');
  await expect(cards.first()).toBeVisible();

  const count = await cards.count();
  const seated: string[] = [];
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    // The card prints "Free" instead of a price when its cheapest ticket costs nothing.
    if ((await card.getByText('Free', { exact: true }).count()) > 0) continue;

    const title = (await card.innerText()).split('\n')[0]?.trim() ?? `card ${i}`;
    await card.click();

    /*
      Which kind of event this is cannot be told from the listing card, so it is read from the
      event page: either a quantity picker appears or the seating notice does. Racing the two
      rather than waiting for one and timing out on the other keeps a seated event cheap to
      reject — a 20-second timeout per candidate would time the whole suite out instead.
    */
    const quantity = page.locator('select[aria-label^="Quantity"]').first();
    const seatMap = page.getByText('Pick your seats on the seat map');
    await expect(quantity.or(seatMap).first()).toBeVisible({ timeout: 20_000 });
    if (await quantity.isVisible()) return;

    seated.push(title);
    await page.goto(listing);
    await expect(cards.first()).toBeVisible();
  }
  throw new Error(
    `No paid, quantity-sold event on this page. ${count} listed; seated: ${
      seated.join(', ') || 'none'
    }.`,
  );
}
