import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, CUSTOMER } from './helpers';

/**
 * The seat page as a buyer uses it.
 *
 * Reported by the owner, with BookMyShow's seat layout for comparison: the page opened on
 * "Select seats" with no film, cinema or time; there was no way to say how many tickets; the
 * map scrolled the whole page sideways on a phone; and the pay button was a long scroll below
 * the seats. These pin the redesign's promises, not its pixels.
 */

interface Seat {
  id: string;
  label: string;
  colIndex: number;
  categoryId: string;
  status: string;
  kind: string;
}

/**
 * A screening of the seeded film with three free, ordinary seats side by side — found through the
 * API rather than assumed, because other specs sell seats in the same shows.
 */
async function showWithThreeTogether(request: APIRequestContext) {
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
        const seats = [...row.seats].sort((a, b) => a.colIndex - b.colIndex);
        for (let i = 0; i + 2 < seats.length; i += 1) {
          const run = seats.slice(i, i + 3);
          const together = run.every(
            (seat, j) =>
              seat.status === 'AVAILABLE' &&
              seat.kind !== 'WHEELCHAIR' &&
              seat.kind !== 'COMPANION' &&
              seat.categoryId === run[0].categoryId &&
              (j === 0 || seat.colIndex === run[j - 1].colIndex + 1),
          );
          if (together) {
            return {
              sessionId: show.sessionId,
              seats: run.map((seat) => `${row.label}${seat.label}`),
            };
          }
        }
      }
    }
  }
  throw new Error('No screening of skyfront-protocol has three free seats together.');
}

const seat = (page: import('@playwright/test').Page, name: string) =>
  page.locator(`button[aria-label^="Seat ${name},"]`);

test.describe('choosing seats', () => {
  let show: Awaited<ReturnType<typeof showWithThreeTogether>>;

  test.beforeAll(async ({ request }) => {
    show = await showWithThreeTogether(request);
  });

  test('1: the page says which show it is before the seats', async ({ page, request }) => {
    const summary = await (await request.get(`${API}/public/shows/${show.sessionId}`)).json();
    await page.goto(`${CUSTOMER}/shows/${show.sessionId}`);

    await expect(page.getByRole('heading', { level: 1, name: summary.movie.title })).toBeVisible({
      timeout: 20_000,
    });
    // The way back is to the film, not the browser's history.
    await expect(
      page.getByRole('link', { name: `Back to ${summary.movie.title}` }),
    ).toHaveAttribute('href', `/movies/${summary.movie.slug}`);
    // The map keeps its own heading, which the older specs find it by.
    await expect(page.getByRole('heading', { name: 'Select seats' })).toBeVisible();
  });

  test('2: choosing two tickets picks two seats side by side in one tap', async ({ page }) => {
    await page.goto(`${CUSTOMER}/shows/${show.sessionId}`);
    const [first, second, third] = show.seats;
    await expect(seat(page, first)).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: '2 tickets', exact: true }).click();
    await seat(page, first).click();

    await expect(seat(page, first)).toHaveAttribute('aria-pressed', 'true');
    await expect(seat(page, second)).toHaveAttribute('aria-pressed', 'true');
    await expect(seat(page, third)).toHaveAttribute('aria-pressed', 'false');
    // The summary names both, with their row.
    await expect(page.getByText(`${first}, ${second}`, { exact: true })).toBeVisible();
    await expect(page.getByText('Total (2 seats)')).toBeVisible();
  });

  test('3: without a ticket count, each tap still toggles one seat', async ({ page }) => {
    await page.goto(`${CUSTOMER}/shows/${show.sessionId}`);
    const [first, second] = show.seats;
    await expect(seat(page, first)).toBeVisible({ timeout: 20_000 });

    await seat(page, first).click();
    await expect(seat(page, first)).toHaveAttribute('aria-pressed', 'true');
    await expect(seat(page, second)).toHaveAttribute('aria-pressed', 'false');
    await seat(page, first).click();
    await expect(seat(page, first)).toHaveAttribute('aria-pressed', 'false');
  });

  test('4: the arrow keys move between seats, and one seat is the tab stop', async ({ page }) => {
    await page.goto(`${CUSTOMER}/shows/${show.sessionId}`);
    const [first, second] = show.seats;
    await expect(seat(page, first)).toBeVisible({ timeout: 20_000 });

    await seat(page, first).focus();
    await page.keyboard.press('ArrowRight');
    await expect(seat(page, second)).toBeFocused();
    // Tab no longer walks the whole room: exactly one seat is in the tab order.
    await expect(page.locator('button[aria-label^="Seat "][tabindex="0"]')).toHaveCount(1);
  });

  test('5: on a phone the page never scrolls sideways, and the pay button stays in reach', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${CUSTOMER}/shows/${show.sessionId}`);
    const [first] = show.seats;
    await expect(seat(page, first)).toBeAttached({ timeout: 20_000 });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // It was 206 px on a twelve-seat room.
    expect(overflow).toBeLessThanOrEqual(0);

    await seat(page, first).scrollIntoViewIfNeeded();
    await seat(page, first).click();
    const pay = page.getByRole('button', { name: /Proceed to pay/i });
    await expect(pay).toBeVisible();
    await expect(pay).toBeInViewport();
    await context.close();
  });

  test('6: the basket names the block the seats are in, and the price category when it differs', async ({
    page,
  }) => {
    /*
      Reported by the owner: seats tapped under "BALCONY" were listed as "Premium". The seeded
      rooms name their blocks after their categories, so the layout is renamed in flight to the
      reported shape — a Balcony block sold at a Premium price.
    */
    let chosen = '';
    await page.route(`**/public/shows/${show.sessionId}/seats**`, async (route) => {
      const response = await route.fetch();
      const layout = await response.json();
      const section = layout.sections[0];
      const target = section.rows
        .flatMap((row: { label: string; seats: Seat[] }) =>
          row.seats.map((s) => ({ seat: s, row: row.label })),
        )
        .find(
          ({ seat: s }: { seat: Seat }) =>
            s.status === 'AVAILABLE' && s.kind !== 'WHEELCHAIR' && s.kind !== 'COMPANION',
        );
      chosen = `${target.row}${target.seat.label}`;
      section.name = 'BALCONY';
      layout.categories.find((c: { id: string }) => c.id === target.seat.categoryId).name =
        'Premium';
      await route.fulfill({ response, json: layout });
    });

    await page.goto(`${CUSTOMER}/shows/${show.sessionId}`);
    await expect(page.getByRole('heading', { name: 'Select seats' })).toBeVisible({
      timeout: 20_000,
    });
    await seat(page, chosen).click();

    const basket = page.locator('#seat-summary');
    await expect(basket.getByText('BALCONY')).toBeVisible();
    await expect(basket.getByText('· Premium')).toBeVisible();
  });
});
