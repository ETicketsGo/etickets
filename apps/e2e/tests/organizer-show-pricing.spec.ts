import AxeBuilder from '@axe-core/playwright';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, CUSTOMER, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * Show pricing, end to end.
 *
 * These exist because a static read of the code suggested that changing a ticket price
 * required cloning and republishing a seat layout version — which would have made a routine
 * commercial change a dangerous one. Run against the real product, that turned out to be
 * false: price lives on the show's ticket type, the layout is only the template a new show
 * is created from. The tests below pin that down so nobody has to re-derive it, and so the
 * boundary cannot quietly move.
 *
 * Nothing here stubs the API. Prices are read back from the customer's own seat map, which
 * is the only place the claim actually matters.
 */

const OWNER = 'owner@eticketsgo.test';
const TZ = 'Asia/Kolkata';

interface Fixture {
  organizationId: string;
  cinemaId: string;
  screenId: string;
  movieId: string;
  movieSlug: string;
  categories: { STANDARD: string; PREMIUM: string };
  layoutCountBefore: number;
}

const describeViolations = (
  violations: {
    id: string;
    impact?: string | null;
    help: string;
    nodes: { target: unknown[] }[];
  }[],
) =>
  violations
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join('\n  ')}`,
    )
    .join('\n');

/** A future instant at a given IST wall-clock time, built without trusting the runner's zone. */
function istInstant(daysAhead: number, hour: number, minute = 0): string {
  const d = new Date(Date.now() + daysAhead * 864e5);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 5, minute - 30),
  ).toISOString();
}

const istDate = (daysAhead: number): string => {
  const d = new Date(Date.now() + daysAhead * 864e5);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
};

async function buildCinema(request: APIRequestContext, token: string): Promise<Fixture> {
  const auth = { Authorization: `Bearer ${token}` };
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs[0] : orgs.data?.[0])?.id as string;

  const cinema = await (
    await request.post(`${API}/cinemas`, {
      headers: auth,
      data: {
        organizationId,
        name: `Pricing Cinema ${suffix}`,
        city: 'Bengaluru',
        address: '1 QA Road',
        timezone: TZ,
      },
    })
  ).json();
  const screen = await (
    await request.post(`${API}/cinemas/${cinema.id}/screens`, {
      headers: auth,
      data: { name: 'Screen 1', screenType: '2D', capacity: 20 },
    })
  ).json();
  const layout = await (
    await request.post(`${API}/screens/${screen.id}/seatmap`, {
      headers: auth,
      data: {
        name: 'Main',
        sections: [
          {
            name: 'Stalls',
            categoryName: 'STANDARD',
            basePriceMinor: 20000,
            rowLabels: ['A'],
            seatsPerRow: 5,
          },
          {
            name: 'Balcony',
            categoryName: 'PREMIUM',
            basePriceMinor: 30000,
            rowLabels: ['B'],
            seatsPerRow: 5,
          },
        ],
      },
    })
  ).json();
  const movie = await (
    await request.post(`${API}/movies`, {
      headers: auth,
      data: {
        organizationId,
        title: `Pricing Feature ${suffix}`,
        runtimeMinutes: 100,
        language: 'Hindi',
        genres: ['Drama'],
      },
    })
  ).json();
  await request.post(`${API}/movies/${movie.id}/status`, {
    headers: auth,
    data: { status: 'PUBLISHED' },
  });

  const layouts = await (
    await request.get(`${API}/screens/${screen.id}/seat-layouts`, { headers: auth })
  ).json();

  const byName = Object.fromEntries(
    (layout.categories as { id: string; name: string }[]).map((c) => [c.name, c.id]),
  );
  return {
    organizationId,
    cinemaId: cinema.id,
    screenId: screen.id,
    movieId: movie.id,
    movieSlug: movie.slug,
    categories: { STANDARD: byName.STANDARD, PREMIUM: byName.PREMIUM },
    layoutCountBefore: layouts.length,
  };
}

const schedule = async (
  request: APIRequestContext,
  token: string,
  f: Fixture,
  startsAt: string,
  endsAt: string,
  pricing?: { seatCategoryId: string; priceMinor: number }[],
) =>
  (
    await request.post(`${API}/movies/${f.movieId}/shows`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { screenId: f.screenId, startsAt, endsAt, ...(pricing ? { pricing } : {}) },
    })
  ).json();

/** What a CUSTOMER is quoted, which is the only price that matters. */
const customerPrices = async (request: APIRequestContext, sessionId: string) => {
  const seats = await (await request.get(`${API}/public/shows/${sessionId}/seats`)).json();
  return Object.fromEntries(
    (seats.categories as { name: string; priceMinor: number }[]).map((c) => [c.name, c.priceMinor]),
  ) as Record<string, number>;
};

/** Open the schedule day view and the pricing dialog for the only show on it. */
async function gotoDay(page: Page, f: Fixture, date: string) {
  await page.goto(`${ORGANIZER}/organizer/cinemas/${f.cinemaId}/schedule`);
  // The page defaults to today in the CINEMA's zone; the date field is the only way in.
  const field = page.getByLabel('Date', { exact: true });
  await expect(field).toBeVisible({ timeout: 20_000 });
  await field.fill(date);
}

async function openPricing(page: Page, f: Fixture, date: string) {
  await gotoDay(page, f, date);
  const button = page.getByRole('button', { name: /^Set prices for/ }).first();
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // The rows arrive from the API; waiting on them means the dialog has real data, not a
  // spinner that would make every later assertion race.
  await expect(page.getByTestId('pricing-rows')).toBeVisible({ timeout: 20_000 });
}

test.describe('show pricing', () => {
  let tokens: AuthTokens;
  let f: Fixture;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, OWNER);
    f = await buildCinema(request, tokens.accessToken);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('1-2: the organizer can open a show and see every category priced', async ({
    page,
    request,
  }) => {
    const show = await schedule(
      request,
      tokens.accessToken,
      f,
      istInstant(20, 14),
      istInstant(20, 16),
    );
    await openPricing(page, f, istDate(20));

    await expect(page.getByTestId('pricing-row-STANDARD')).toBeVisible();
    await expect(page.getByTestId('pricing-row-PREMIUM')).toBeVisible();
    await expect(page.getByLabel('STANDARD price in rupees')).toHaveValue('200.00');
    await expect(page.getByLabel('PREMIUM price in rupees')).toHaveValue('300.00');
    expect(await customerPrices(request, show.sessionId)).toEqual({
      STANDARD: 20000,
      PREMIUM: 30000,
    });
  });

  test('3-4: changing a price reaches the customer', async ({ page, request }) => {
    const show = await schedule(
      request,
      tokens.accessToken,
      f,
      istInstant(21, 14),
      istInstant(21, 16),
    );
    await openPricing(page, f, istDate(21));

    await page.getByLabel('PREMIUM price in rupees').fill('420.50');
    // The summary states the move before it is made, because "did I just triple the
    // balcony" is the question an operator actually has.
    await expect(page.getByTestId('pricing-summary')).toContainText('₹300.00 → ₹420.50');
    await page.getByRole('button', { name: /^Save price/ }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 20_000 });

    await expect
      .poll(() => customerPrices(request, show.sessionId), { timeout: 20_000 })
      .toEqual({ STANDARD: 20000, PREMIUM: 42050 });
  });

  test('5-6: a second show on the same layout prices independently, and no layout is cloned', async ({
    page,
    request,
  }) => {
    const early = await schedule(
      request,
      tokens.accessToken,
      f,
      istInstant(22, 11),
      istInstant(22, 13),
    );
    const late = await schedule(
      request,
      tokens.accessToken,
      f,
      istInstant(22, 19),
      istInstant(22, 21),
    );

    await gotoDay(page, f, istDate(22));
    const buttons = page.getByRole('button', { name: /^Set prices for/ });
    await expect(buttons).toHaveCount(2, { timeout: 20_000 });

    await buttons.first().click();
    await expect(page.getByTestId('pricing-rows')).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('STANDARD price in rupees').fill('120');
    await page.getByRole('button', { name: /^Save price/ }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 20_000 });

    await expect
      .poll(() => customerPrices(request, early.sessionId), { timeout: 20_000 })
      .toMatchObject({ STANDARD: 12000 });
    // The other showing is untouched: the price belongs to the show, not the room.
    expect(await customerPrices(request, late.sessionId)).toMatchObject({ STANDARD: 20000 });

    // And the room is exactly as it was. This is the claim the whole exercise was about.
    const layouts = await (
      await request.get(`${API}/screens/${f.screenId}/seat-layouts`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
    ).json();
    expect(layouts).toHaveLength(f.layoutCountBefore);
    const seatmap = await (
      await request.get(`${API}/screens/${f.screenId}/seatmap`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
    ).json();
    expect(
      (seatmap.categories as { name: string; basePriceMinor: number }[]).find(
        (c) => c.name === 'STANDARD',
      )!.basePriceMinor,
    ).toBe(20000);
  });

  test('7-8: a sold seat freezes its category; a new buyer pays the new price', async ({
    page,
    request,
  }) => {
    const show = await schedule(
      request,
      tokens.accessToken,
      f,
      istInstant(23, 14),
      istInstant(23, 16),
    );
    const seats = await (await request.get(`${API}/public/shows/${show.sessionId}/seats`)).json();
    const premium = (seats.categories as { name: string; id: string; ticketTypeId: string }[]).find(
      (c) => c.name === 'PREMIUM',
    )!;
    const premiumSeats = (
      seats.sections as { rows: { seats: { id: string; categoryId: string }[] }[] }[]
    )
      .flatMap((s) => s.rows)
      .flatMap((r) => r.seats)
      .filter((s) => s.categoryId === premium.id);

    const booking = await (
      await request.post(`${API}/bookings/guest`, {
        data: {
          eventSessionId: show.sessionId,
          items: [
            { ticketTypeId: premium.ticketTypeId, quantity: 1, seatIds: [premiumSeats[0].id] },
          ],
          buyerName: 'Early Bird',
          buyerEmail: `early_${Date.now()}@e2e.test`,
        },
      })
    ).json();
    expect(booking.fees.subtotalMinor).toBe(30000);
    await request.post(`${API}/payments/${booking.id}/mock-pay`, { data: {} });

    await openPricing(page, f, istDate(23));
    const premiumField = page.getByLabel('PREMIUM price in rupees');
    await expect(premiumField).toBeDisabled();
    // Disabled with no reason beside it reads as a bug. It says which and at what.
    await expect(page.getByTestId('pricing-row-PREMIUM')).toContainText(
      '1 seat has sold at ₹300.00',
    );

    // The rest of the show is still commercially live.
    await page.getByLabel('STANDARD price in rupees').fill('275');
    await page.getByRole('button', { name: /^Save price/ }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 20_000 });

    await expect
      .poll(() => customerPrices(request, show.sessionId), { timeout: 20_000 })
      .toEqual({ STANDARD: 27500, PREMIUM: 30000 });

    /*
      The paid booking never moved. Read through the organizer's own orders view — a guest
      booking is not readable by id even to the organizer who owns the show, which is the
      correct ownership rule and not something to work around for a test.
    */
    const listing = await (await request.get(`${API}/public/movies/${f.movieSlug}/shows`)).json();
    const eventId = (listing.shows as { sessionId: string; eventId: string }[]).find(
      (s) => s.sessionId === show.sessionId,
    )!.eventId;
    const orders = await (
      await request.get(`${API}/events/${eventId}/orders`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
    ).json();
    const mine = (orders.data as { id: string; totalMinor: number; status: string }[]).find(
      (o) => o.id === booking.id,
    )!;
    // The order still owes what it owed. Repricing STANDARD did not touch it, and neither
    // did the refused attempt on PREMIUM.
    expect(mine.totalMinor).toBe(booking.fees.totalMinor);
    expect(mine.status).toBe('CONFIRMED');
  });

  test('9: an invalid price is refused in the form, before it can reach the server', async ({
    page,
    request,
  }) => {
    await schedule(request, tokens.accessToken, f, istInstant(24, 14), istInstant(24, 16));
    await openPricing(page, f, istDate(24));

    const field = page.getByLabel('STANDARD price in rupees');
    await field.fill('');
    // A blank field must not read as "free". `Number('')` is 0, and that is the bug this
    // guards.
    await expect(
      page.getByRole('alert').filter({ hasText: 'Enter a price for STANDARD' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^Save price/ })).toBeDisabled();

    await field.fill('12.345');
    await expect(page.getByRole('alert').filter({ hasText: 'at most two decimals' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Save price/ })).toBeDisabled();

    await field.fill('250');
    await expect(page.getByRole('button', { name: /^Save price/ })).toBeEnabled();
  });

  test('10-11: another tenant cannot read or reprice this show', async ({ request }) => {
    const show = await schedule(
      request,
      tokens.accessToken,
      f,
      istInstant(25, 14),
      istInstant(25, 16),
    );
    const pricing = await (
      await request.get(`${API}/shows/${show.sessionId}/pricing`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
    ).json();

    // No credentials at all.
    expect((await request.get(`${API}/shows/${show.sessionId}/pricing`)).status()).toBe(401);

    // A signed-in customer with no organizer role.
    const email = `pricing_outsider_${Date.now()}@e2e.test`;
    const reg = await (
      await request.post(`${API}/auth/register`, {
        data: { email, password: 'Password123!', fullName: 'Out Sider' },
      })
    ).json();
    const outsider = { Authorization: `Bearer ${reg.accessToken}` };
    expect(
      (await request.get(`${API}/shows/${show.sessionId}/pricing`, { headers: outsider })).status(),
    ).toBe(403);
    const attempt = await request.patch(`${API}/shows/${show.sessionId}/pricing`, {
      headers: outsider,
      data: { prices: [{ ticketTypeId: pricing.categories[0].ticketTypeId, priceMinor: 1 }] },
    });
    expect(attempt.status()).toBe(403);

    // And the price is exactly where it was.
    expect(await customerPrices(request, show.sessionId)).toMatchObject({ PREMIUM: 30000 });
  });

  test('12: a cancelled show cannot be repriced, and says so', async ({ request }) => {
    const show = await schedule(
      request,
      tokens.accessToken,
      f,
      istInstant(26, 14),
      istInstant(26, 16),
    );
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const pricing = await (
      await request.get(`${API}/shows/${show.sessionId}/pricing`, { headers: auth })
    ).json();
    await request.post(`${API}/shows/${show.sessionId}/cancel`, {
      headers: auth,
      data: { reason: 'Pricing e2e' },
    });

    const res = await request.patch(`${API}/shows/${show.sessionId}/pricing`, {
      headers: auth,
      data: { prices: [{ ticketTypeId: pricing.categories[0].ticketTypeId, priceMinor: 100 }] },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).message).toMatch(/cancelled/i);
  });

  test('13-14: readiness blocks on a show priced at zero and clears once it is priced', async ({
    page,
    request,
  }) => {
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const show = await schedule(
      request,
      tokens.accessToken,
      f,
      istInstant(27, 14),
      istInstant(27, 16),
      [
        { seatCategoryId: f.categories.STANDARD, priceMinor: 0 },
        { seatCategoryId: f.categories.PREMIUM, priceMinor: 0 },
      ],
    );

    await page.goto(`${ORGANIZER}/organizer/cinemas/${f.cinemaId}/readiness`);
    const zero = page.getByTestId('check-SHOWS_PRICED_AT_ZERO');
    await expect(zero).toBeVisible({ timeout: 20_000 });
    await expect(zero).toHaveAttribute('data-level', 'BLOCKED');
    // A layout priced at ₹200/₹300 does not excuse a show that would give the seat away.
    await expect(zero).toContainText('sell a seat for nothing');
    // The fix path is the schedule, because that is where a show price lives.
    await expect(zero.getByRole('link', { name: 'Fix this' })).toHaveAttribute(
      'href',
      `/organizer/cinemas/${f.cinemaId}/schedule`,
    );

    const pricing = await (
      await request.get(`${API}/shows/${show.sessionId}/pricing`, { headers: auth })
    ).json();
    await request.patch(`${API}/shows/${show.sessionId}/pricing`, {
      headers: auth,
      data: {
        prices: (pricing.categories as { ticketTypeId: string }[]).map((c) => ({
          ticketTypeId: c.ticketTypeId,
          priceMinor: 21000,
        })),
      },
    });

    await page.getByRole('button', { name: 'Re-check' }).click();
    await expect(page.getByTestId('check-SHOWS_PRICED_AT_ZERO')).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('check-PRICING_SET')).toBeVisible({ timeout: 20_000 });
  });

  test('15: the pricing dialog has no accessibility violations', async ({ page, request }) => {
    await schedule(request, tokens.accessToken, f, istInstant(28, 14), istInstant(28, 16));
    await openPricing(page, f, istDate(28));

    /*
      Wait for the dialog to finish fading in. Scanning mid-transition composites the text
      against the page behind it and reports contrast failures that do not exist — a false
      finding this suite has produced before. This waits on a CONDITION, not a duration.
    */
    await expect
      .poll(() => page.getByRole('dialog').evaluate((el) => Number(getComputedStyle(el).opacity)), {
        timeout: 10_000,
      })
      .toBe(1);

    const results = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(describeViolations(results.violations)).toBe('');
  });

  test('16: the whole customer journey quotes one price from listing to checkout', async ({
    page,
    request,
  }) => {
    const show = await schedule(
      request,
      tokens.accessToken,
      f,
      istInstant(29, 18),
      istInstant(29, 20),
      [
        { seatCategoryId: f.categories.STANDARD, priceMinor: 24000 },
        { seatCategoryId: f.categories.PREMIUM, priceMinor: 36000 },
      ],
    );

    // Listing: the cheapest bookable price for the screening.
    const listing = await (await request.get(`${API}/public/movies/${f.movieSlug}/shows`)).json();
    const row = (
      listing.shows as { sessionId: string; fromPriceMinor: number; currency: string }[]
    ).find((s) => s.sessionId === show.sessionId)!;
    expect(row.fromPriceMinor).toBe(24000);
    expect(row.currency).toBe('INR');

    // Seat map: per category.
    expect(await customerPrices(request, show.sessionId)).toEqual({
      STANDARD: 24000,
      PREMIUM: 36000,
    });

    // Booking: the server's own arithmetic, from a request that never mentions a price.
    const seats = await (await request.get(`${API}/public/shows/${show.sessionId}/seats`)).json();
    const std = (seats.categories as { name: string; id: string; ticketTypeId: string }[]).find(
      (c) => c.name === 'STANDARD',
    )!;
    const seat = (seats.sections as { rows: { seats: { id: string; categoryId: string }[] }[] }[])
      .flatMap((s) => s.rows)
      .flatMap((r) => r.seats)
      .find((s) => s.categoryId === std.id)!;
    const booking = await (
      await request.post(`${API}/bookings/guest`, {
        data: {
          eventSessionId: show.sessionId,
          items: [{ ticketTypeId: std.ticketTypeId, quantity: 1, seatIds: [seat.id] }],
          buyerName: 'Journey Buyer',
          buyerEmail: `journey_${Date.now()}@e2e.test`,
        },
      })
    ).json();
    expect(booking.fees.subtotalMinor).toBe(24000);
    // Total is subtotal plus the customer's share of fees, never less than the ticket.
    expect(booking.fees.totalMinor).toBeGreaterThanOrEqual(24000);

    /*
      And the customer sees the same number in the browser. The film page lists showtimes;
      the price per category is on the seat map, which is where a buyer commits — so that is
      where the figure has to agree.
    */
    await page.goto(`${CUSTOMER}/shows/${show.sessionId}`);
    await expect(page.getByText(/240/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/360/).first()).toBeVisible({ timeout: 20_000 });
  });

  test('17: a price submitted by the client is ignored', async ({ request }) => {
    const show = await schedule(
      request,
      tokens.accessToken,
      f,
      istInstant(30, 14),
      istInstant(30, 16),
    );
    const seats = await (await request.get(`${API}/public/shows/${show.sessionId}/seats`)).json();
    const premium = (seats.categories as { name: string; id: string; ticketTypeId: string }[]).find(
      (c) => c.name === 'PREMIUM',
    )!;
    const seat = (seats.sections as { rows: { seats: { id: string; categoryId: string }[] }[] }[])
      .flatMap((s) => s.rows)
      .flatMap((r) => r.seats)
      .find((s) => s.categoryId === premium.id)!;

    const booking = await (
      await request.post(`${API}/bookings/guest`, {
        data: {
          eventSessionId: show.sessionId,
          // Every shape a tampering client might try. None is in the contract.
          items: [
            {
              ticketTypeId: premium.ticketTypeId,
              quantity: 1,
              seatIds: [seat.id],
              unitPriceMinor: 500,
              priceMinor: 500,
            },
          ],
          subtotalMinor: 500,
          totalMinor: 500,
          buyerName: 'Tamper',
          buyerEmail: `tamper_${Date.now()}@e2e.test`,
        },
      })
    ).json();

    expect(booking.fees.subtotalMinor).toBe(30000);
    expect(booking.fees.totalMinor).toBeGreaterThan(500);
  });
});
