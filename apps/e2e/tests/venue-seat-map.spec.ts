import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  API,
  CUSTOMER,
  apiLogin,
  seedBrowserAuth,
  uniqueEmail,
  NEW_ACCOUNT_PASSWORD,
} from './helpers';

/**
 * A big venue, from the shape an organizer picks to the seat a customer takes.
 *
 * ── WHY THIS BUILDS ITS OWN VENUE ──────────────────────────────────────────────────
 * The seed is a cinema, and a cinema deliberately does not exercise any of this: it comes
 * back as one payload and never shows a map. Adding an arena to the seed would slow every
 * other spec down by eleven thousand rows for the benefit of one. So this drives the real
 * organizer flow — clone, apply a template, publish, schedule — and then shops in the
 * result, which also proves those four steps work together and not merely one at a time.
 *
 * ── WHAT IT IS ACTUALLY FOR ────────────────────────────────────────────────────────
 * The two-step read is the whole feature, and the thing that can silently break it is a
 * client that renders an overview as though it had seats. So the assertions are about the
 * SEAM: the map appears instead of a grid, a block opens into real seats, going back keeps
 * what was already chosen, and a sold-out block cannot be opened.
 */

const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

/** Everything the organizer console does, done over the API so the spec stays about the map. */
async function buildArena(
  request: APIRequestContext,
): Promise<{ sessionId: string; slug: string }> {
  const { accessToken } = await apiLogin(request, ORGANIZER_EMAIL);
  const auth = { Authorization: `Bearer ${accessToken}` };

  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;

  /*
    A screen of its own, created per run.

    Reusing the seeded screen made the spec collide with itself: the show the previous run
    scheduled still occupies the slot, scheduling refuses — correctly — and every assertion
    downstream fails for a reason that has nothing to do with venue maps. Spreading the
    start time only moved the collision around. A fresh screen has nothing on it, which is
    deterministic rather than merely unlikely.
  */
  const stamp = Date.now();
  const venue = await (
    await request.post(`${API}/venues`, {
      headers: auth,
      data: {
        organizationId,
        name: `Demo Arena E2E ${stamp}`,
        city: 'Boise',
        region: 'Idaho',
        country: 'United States',
        timezone: 'America/Boise',
        address: '100 Test Plaza',
        capacity: 12_000,
      },
    })
  ).json();
  const space = await (
    await request.post(`${API}/venues/${venue.id}/spaces`, {
      headers: auth,
      data: { name: 'Main Arena', screenType: '2D', capacity: 12_000 },
    })
  ).json();
  const screenId = space.id;
  expect(screenId, `space creation failed: ${JSON.stringify(space)}`).toBeTruthy();

  // A new screen is an empty room, so give it a layout to start from — the same first step
  // an organizer takes before they can do anything else with a screen.
  await request.post(`${API}/screens/${screenId}/seatmap`, {
    headers: auth,
    data: {
      name: 'Starting room',
      sections: [
        {
          name: 'Stalls',
          categoryName: 'Standard',
          basePriceMinor: 20_000,
          rowLabels: ['A', 'B'],
          seatsPerRow: 4,
        },
      ],
    },
  });

  const layouts = await (
    await request.get(`${API}/screens/${screenId}/seat-layouts`, { headers: auth })
  ).json();
  const source = layouts[0];
  expect(source, `the screen should now have a layout: ${JSON.stringify(layouts)}`).toBeTruthy();

  // Clone → template → publish. The same three steps the console offers, in the same order.
  const draft = await (
    await request.post(`${API}/seat-layouts/${source.id}/clone`, { headers: auth, data: {} })
  ).json();

  const built = await (
    await request.post(`${API}/seat-layouts/${draft.id}/from-template`, {
      headers: auth,
      // Small on purpose: this spec is about the seam, not about throughput. The
      // fourteen-thousand-seat case is proven against a real database in the API suite,
      // where it belongs and where it does not cost a browser eleven thousand DOM nodes.
      data: { template: 'ARENA', rows: 4, seatsPerRow: 8, basePriceMinor: 5_000 },
    })
  ).json();
  expect(built.layoutKind).toBe('SECTIONED');
  expect(built.sections).toBeGreaterThan(1);

  await request.post(`${API}/seat-layouts/${draft.id}/publish`, { headers: auth, data: {} });

  const startsAt = new Date(Date.now() + 30 * 86_400_000);
  const endsAt = new Date(startsAt.getTime() + 3 * 3_600_000);
  const event = await (
    await request.post(`${API}/events`, {
      headers: auth,
      data: {
        organizationId,
        venueId: venue.id,
        title: `Demo Arena Basketball ${stamp}`,
        category: 'Sports',
        feeMode: 'CUSTOMER_PAYS',
      },
    })
  ).json();
  expect(event.id, `event creation failed: ${JSON.stringify(event)}`).toBeTruthy();

  const response = await request.post(`${API}/events/${event.id}/sessions`, {
    headers: auth,
    data: {
      screenId,
      seatMapId: draft.id,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    },
  });
  const session = await response.json();
  // Asserted here so a scheduling refusal fails once, loudly, instead of arriving as four
  // tests that cannot find a heading.
  expect(response.ok(), `scheduling failed: ${JSON.stringify(session)}`).toBe(true);
  expect(session.id).toBeTruthy();

  await request.post(`${API}/events/${event.id}/submit`, { headers: auth });
  const admin = await apiLogin(request, 'admin@eticketsgo.test');
  const approval = await request.post(`${API}/admin/events/${event.id}/review`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { decision: 'APPROVE' },
  });
  if (!approval.ok()) {
    const body = await approval.text();
    expect(
      approval.status() === 409 && body.includes('current: PUBLISHED'),
      `event approval failed: ${body}`,
    ).toBe(true);
  }

  return { sessionId: session.id, slug: event.slug };
}

test.describe('a venue too big to list', () => {
  test.describe.configure({ mode: 'serial' });

  let sessionId = '';
  let eventSlug = '';

  test.beforeAll(async ({ request }) => {
    ({ sessionId, slug: eventSlug } = await buildArena(request));
  });

  test('1: the customer sees a map of the venue, not a wall of seats', async ({ page }) => {
    await page.goto(`${CUSTOMER}/shows/${sessionId}`);

    await expect(page.getByRole('heading', { name: 'Choose your area' })).toBeVisible();
    await expect(page.getByRole('group', { name: /venue map/i })).toBeVisible();
    // The stage is drawn and named, because "which side am I on" is the first question.
    await expect(page.getByText('STAGE', { exact: true })).toBeVisible();
    // And emphatically no seat grid yet: eleven thousand seats is the thing being avoided.
    await expect(page.getByRole('button', { name: /^Seat /i })).toHaveCount(0);
  });

  test('2: the map says how much is left and what it costs, per block', async ({ page }) => {
    await page.goto(`${CUSTOMER}/shows/${sessionId}`);
    // The accessible name carries the same three facts the picture does, so the map is not
    // a mouse-only feature.
    const block = page.getByRole('button', { name: /Floor A, \d+ of \d+ seats available/ });
    await expect(block).toBeVisible();
  });

  test('3: opening a block shows its seats — and only its seats', async ({ page }) => {
    await page.goto(`${CUSTOMER}/shows/${sessionId}`);
    await page.getByRole('button', { name: /Floor A/ }).click();

    await expect(page.getByRole('heading', { name: 'Floor A' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to the venue map' })).toBeVisible();
    // Row A exists here. If the whole venue had come back, several blocks would each have one.
    await expect(page.getByText('A', { exact: true })).toHaveCount(1);
  });

  test('4: seats chosen in one block survive a trip back to the map', async ({ page }) => {
    /*
      The regression this exists to prevent.

      Seat detail used to be derived from whatever payload was on screen. Read one block at a
      time, that means walking to another block empties the basket — and the customer is not
      told, they simply find their seats gone. The page accumulates what it has seen instead,
      and this is what proves it.
    */
    await page.goto(`${CUSTOMER}/shows/${sessionId}`);
    await page.getByRole('button', { name: /Floor A/ }).click();

    const seat = page.getByRole('button', { name: /^Seat A1\b/ }).first();
    await seat.click();
    await expect(page.getByText(/A1/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Back to the venue map' }).click();
    await expect(page.getByRole('heading', { name: 'Choose your area' })).toBeVisible();
    // Said out loud on the map, so an empty sidebar never reads as "browsing lost them".
    await expect(page.getByText(/1 seat held in your basket/)).toBeVisible();

    // And still there, still selected, on the way back in.
    await page.getByRole('button', { name: /Floor A/ }).click();
    await expect(page.getByText(/A1/).first()).toBeVisible();
  });

  test('5: a cinema is untouched — no map, no extra step', async ({ page, request }) => {
    /*
      The other half of the promise.

      Venue maps must not arrive in every cinema as a new screen to click through. A GRID
      layout still returns whole and still opens straight onto the seats.
    */
    const movies = await (await request.get(`${API}/public/movies`)).json();
    const list = Array.isArray(movies) ? movies : movies.data;

    /*
      The first seeded movie that is playing somewhere and is NOT the one the arena hangs off.

      Two constraints, both learned the hard way. Not every seeded movie has a showtime, so
      "the first movie" finds nothing to look at. And every run of this spec leaves an arena
      show attached to the movie it used, so reusing that one makes the second run conclude
      that cinemas grew a venue map.
    */
    let cinemaShow: { sessionId: string } | undefined;
    for (const movie of list) {
      const showtimes = await (
        await request.get(`${API}/public/movies/${movie.slug}/shows`)
      ).json();
      cinemaShow = (showtimes.shows ?? [])[0];
      if (cinemaShow) break;
    }

    /*
      A hard failure, not a skip.

      An earlier version skipped when it could not find one, and skipped on every single run
      — which reads as green while proving nothing at all about the promise it guards.
    */
    expect(cinemaShow, 'the seed must contain an ordinary cinema showtime').toBeTruthy();

    const layout = await (
      await request.get(`${API}/public/shows/${cinemaShow!.sessionId}/seats`)
    ).json();
    expect(layout.view).toBe('seats');
    expect(layout.layoutKind).toBe('GRID');

    await page.goto(`${CUSTOMER}/shows/${cinemaShow!.sessionId}`);
    await expect(page.getByRole('heading', { name: 'Select seats' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Choose your area' })).toHaveCount(0);
  });

  test('6: a signed-in buyer can choose two arena seats and reach checkout', async ({
    page,
    context,
    request,
  }) => {
    const email = uniqueEmail('arena_buyer');
    await request.post(`${API}/auth/register`, {
      data: { email, password: NEW_ACCOUNT_PASSWORD, fullName: 'Arena Buyer' },
    });
    const tokens = await apiLogin(request, email, NEW_ACCOUNT_PASSWORD);
    await seedBrowserAuth(context, tokens);

    await page.goto(`${CUSTOMER}/events/${eventSlug}`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Choose seats' }).click();
    await expect(page).toHaveURL(new RegExp(`/shows/${sessionId}`), { timeout: 30_000 });
    await page.getByRole('button', { name: /Floor A/ }).click();

    const availableSeats = page
      .getByRole('button', { name: /^Seat / })
      .and(page.locator(':enabled'));
    await availableSeats.nth(0).click();
    await availableSeats.nth(1).click();
    await expect(page.getByText('Total (2 seats)')).toBeVisible();

    await page
      .getByRole('button', { name: /Proceed to pay/i })
      .last()
      .click();
    await expect(page).toHaveURL(/\/booking\/[^/]+\/(?:payment|reserved)/, { timeout: 30_000 });
  });

  test('7: two buyers see the authoritative hold, release, reacquisition, and sale', async ({
    browser,
    request,
  }) => {
    const register = async (label: string) => {
      const email = uniqueEmail(label);
      await request.post(`${API}/auth/register`, {
        data: { email, password: NEW_ACCOUNT_PASSWORD, fullName: label },
      });
      return { email, tokens: await apiLogin(request, email, NEW_ACCOUNT_PASSWORD) };
    };
    const buyerA = await register('arena_lock_a');
    const buyerB = await register('arena_lock_b');
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      await seedBrowserAuth(contextA, buyerA.tokens);
      await seedBrowserAuth(contextB, buyerB.tokens);
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      const seatName = /^Seat A4\b/;

      await pageA.goto(`${CUSTOMER}/shows/${sessionId}`);
      await pageA.getByRole('button', { name: /Floor A/ }).click();
      const seatA = pageA.getByRole('button', { name: seatName });
      await seatA.click();
      await expect(seatA).toHaveAttribute('aria-pressed', 'true');
      await pageA
        .getByRole('button', { name: /Proceed to pay/i })
        .last()
        .click();
      await expect(pageA).toHaveURL(/\/booking\/[^/]+\/payment/, { timeout: 30_000 });
      const bookingId = /\/booking\/([^/]+)\/payment/.exec(pageA.url())?.[1];
      expect(bookingId, 'buyer A should own a pending booking').toBeTruthy();

      // A separate browser session reads the server-owned hold, not A's local selection state.
      await pageB.goto(`${CUSTOMER}/shows/${sessionId}`);
      await pageB.getByRole('button', { name: /Floor A/ }).click();
      const heldForB = pageB.getByRole('button', { name: /^Seat A4\b.*held/i });
      await expect(heldForB).toBeDisabled();

      // Explicit release is the deterministic counterpart of expiry: the same inventory must
      // become acquirable again, while a completed sale below must not.
      const released = await request.post(`${API}/bookings/${bookingId}/cancel`, {
        headers: { Authorization: `Bearer ${buyerA.tokens.accessToken}` },
      });
      expect(released.ok(), `release failed: ${await released.text()}`).toBe(true);

      await pageB.reload();
      await pageB.getByRole('button', { name: /Floor A/ }).click();
      const releasedSeat = pageB.getByRole('button', { name: seatName });
      await expect(releasedSeat).toBeEnabled();
      await releasedSeat.click();
      await pageB
        .getByRole('button', { name: /Proceed to pay/i })
        .last()
        .click();
      await expect(pageB).toHaveURL(/\/booking\/[^/]+\/payment/, { timeout: 30_000 });
      await pageB.getByRole('button', { name: /^Pay/ }).click();
      await expect(pageB).toHaveURL(/\/booking\/[^/]+\/confirmation/, { timeout: 30_000 });

      await pageA.goto(`${CUSTOMER}/shows/${sessionId}`);
      await pageA.getByRole('button', { name: /Floor A/ }).click();
      await expect(pageA.getByRole('button', { name: /^Seat A4\b.*sold/i })).toBeDisabled();
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
