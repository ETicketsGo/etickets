import { test, expect, type Page } from '@playwright/test';
import { QA_VALIDATE, QA_SKIP_REASON } from './qa-target';

// Deployment-facing: skipped unless asked for. See qa-target.ts for why.
test.skip(!QA_VALIDATE, QA_SKIP_REASON);

/**
 * The price on the page is the price you pay.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * The event page showed the ticket subtotal and the line "Transparent fees shown on the
 * next step". On QA that read ₹998 for a purchase that charges ₹1,033.26 — a booking fee
 * and a payment fee the buyer only met after committing. The seat-picking screen had
 * carried a real breakdown for some time; the ordinary event page, which is most of what
 * this platform sells, never got it.
 *
 * ── WHY THE ASSERTION IS AGAINST THE API AND NOT AGAINST A NUMBER ──────────────────
 * Hardcoding ₹1,033.26 would make this a test of QA's seed data, and it would go red the
 * day somebody edits a fee tier — for no reason a reader could act on. What must be true
 * is a RELATION: the total the page shows is the total the booking will charge. So the
 * test quotes the same cart through the API and compares.
 */
const CUSTOMER = 'https://customer-web-qa.up.railway.app';
const API = 'https://api-qa-f580.up.railway.app/api';

/**
 * The minor-unit value of ONE rendered amount.
 *
 * Deliberately anchored to a single amount rather than stripping non-digits from a block
 * of text. The first version did the latter and worked only by accident: rupee amounts
 * render without decimals, so "₹240 ₹10 ₹5" collapsed to a number. The same code met the
 * first USD event and produced "50.001.99…" — two decimal points, `Number` returns NaN,
 * and the failure looked like the page rather than the parser.
 */
function minorFrom(text: string): number {
  const match = /[\d,]+(?:\.\d+)?/.exec(text);
  return match ? Math.round(Number(match[0].replace(/,/g, '')) * 100) : NaN;
}

async function openFirstPaidEvent(page: Page, request: { get: (u: string) => Promise<Response> }) {
  const list = await (await request.get(`${API}/public/events?pageSize=50`)).json();
  const paid = (list.data ?? list).find(
    (e: { fromPriceMinor?: number }) => (e.fromPriceMinor ?? 0) > 0,
  );
  expect(paid, 'QA needs at least one paid event').toBeTruthy();
  await page.goto(`${CUSTOMER}/events/${paid.slug}`, { waitUntil: 'networkidle' });
  return paid;
}

test.describe('QA: the event page shows the full price, not the subtotal', () => {
  test('picking a ticket reveals the fees and the amount actually payable', async ({
    page,
    request,
  }) => {
    const paid = await openFirstPaidEvent(page, request as never);

    // Nothing selected yet: no invented numbers, and it says why.
    await expect(page.getByTestId('price-breakdown')).toHaveCount(0);

    // By its accessible name, not by position: the first combobox on the page is the
    // language switcher, and `.first()` quietly tested that instead.
    await page
      .getByRole('combobox', { name: /^Quantity of / })
      .first()
      .selectOption('2');

    const breakdown = page.getByTestId('price-breakdown');
    await expect(breakdown).toBeVisible({ timeout: 30_000 });

    // The fees that used to be hidden are named, not merely bundled into a bigger number.
    await expect(breakdown).toContainText(/Booking fee/);

    // And the promise is made explicitly, replacing the apology that used to be here.
    await expect(page.getByText('This is the full amount you will pay.')).toBeVisible();
    await expect(page.getByText('Transparent fees shown on the next step.')).toHaveCount(0);

    /*
      The relation that matters: what the page says equals what the server will charge.
      Quoted through the API for the same cart rather than compared against a literal, so
      this stays true when fee tiers change and fails when the two implementations drift.
    */
    const detail = await (await request.get(`${API}/public/events/${paid.slug}`)).json();
    const session = detail.sessions.find(
      (s: { ticketTypes: unknown[]; seatBased?: boolean }) =>
        s.ticketTypes.length > 0 && !s.seatBased,
    );
    const quoted = await (
      await request.post(`${API}/bookings/quote`, {
        data: {
          eventSessionId: session.id,
          items: [{ ticketTypeId: session.ticketTypes[0].id, quantity: 2 }],
        },
      })
    ).json();

    // The total has its own test id; the previous version walked a sibling, which is a
    // structural assumption that breaks the next time the card is laid out differently.
    expect(minorFrom(await page.getByTestId('price-total').innerText())).toBe(
      quoted.fees.totalMinor,
    );

    // The fees are real, or this test would pass on an event that happens to have none and
    // prove nothing about the defect it exists for.
    expect(quoted.fees.totalMinor).toBeGreaterThan(quoted.fees.subtotalMinor);
  });

  test('the total tracks the quantity rather than going stale', async ({ page, request }) => {
    // A breakdown that does not follow the selection is worse than none: it is a precise
    // number attached to the wrong cart.
    await openFirstPaidEvent(page, request as never);
    const quantity = page.getByRole('combobox', { name: /^Quantity of / }).first();

    await quantity.selectOption('1');
    await expect(page.getByTestId('price-breakdown')).toBeVisible({ timeout: 30_000 });
    const one = minorFrom(await page.getByTestId('price-total').innerText());
    expect(Number.isNaN(one), 'the total did not parse as an amount').toBe(false);

    await quantity.selectOption('3');
    await expect
      .poll(async () => minorFrom(await page.getByTestId('price-total').innerText()), {
        timeout: 30_000,
      })
      .toBeGreaterThan(one);
  });
});
