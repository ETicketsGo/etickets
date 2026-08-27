import { expect, type Page } from '@playwright/test';

/**
 * Open an event that actually charges for a ticket.
 *
 * ── WHY NOT JUST THE FIRST ONE ─────────────────────────────────────────────────────
 * These suites used to click `a[href^="/events/"]`.first() and then look for "Continue to
 * payment". That worked only because every seeded event happened to be paid. The moment a
 * free one was seeded, whichever event sorted first decided whether four unrelated tests
 * passed — and a free event's button says "Get my tickets", because there is no payment
 * step to continue to.
 *
 * A test that is going on to pay for something needs something to pay for. Asking for that
 * explicitly is both what it means and what stops the next free event from breaking it.
 */
export async function openPaidEvent(page: Page): Promise<void> {
  const cards = page.locator('a[href^="/events/"]');
  await expect(cards.first()).toBeVisible();

  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    // The card prints "Free" instead of a price when its cheapest ticket costs nothing.
    if ((await card.getByText('Free', { exact: true }).count()) === 0) {
      await card.click();
      return;
    }
  }
  throw new Error(`No paid event on this page — all ${count} listed events are free.`);
}
