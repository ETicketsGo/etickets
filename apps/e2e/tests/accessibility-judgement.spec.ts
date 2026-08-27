import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, CUSTOMER, apiLogin, seedBrowserAuth, SEED_PASSWORD, uniqueEmail } from './helpers';

/**
 * The WCAG criteria a rule engine cannot decide, checked the only way they can be.
 *
 * ── WHY THIS IS SEPARATE FROM THE SWEEP ────────────────────────────────────────────
 * `accessibility-sweep.spec.ts` runs axe over every route, and axe is very good at things
 * that are true or false about the DOM. It is structurally unable to answer "can somebody
 * actually complete a booking", "does this page work at 320 pixels", or "is there any way to
 * stop the clock" — and the VPAT worksheet marked every one of those *Needs evaluation*.
 *
 * These are the ones automation CAN reach once somebody writes the interaction down. What is
 * left after this — whether alt text is accurate, whether the seat map is usable without
 * sight, whether focus order reads sensibly — still needs a human, and the worksheet still
 * says so.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

interface Paid {
  slug: string;
  sessionId: string;
  ticketTypeId: string;
}

/** A published paid event, so the checkout and its hold timer are reachable. */
async function paidEvent(request: APIRequestContext): Promise<Paid> {
  const { accessToken } = await apiLogin(request, ORGANIZER_EMAIL);
  const auth = { Authorization: `Bearer ${accessToken}` };
  const stamp = Date.now();

  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const venues = await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const venueId = (Array.isArray(venues) ? venues : venues.data)[0].id;

  const event = await (
    await request.post(`${API}/events`, {
      headers: auth,
      data: {
        organizationId,
        title: `A11y Check ${stamp}`,
        category: 'Music',
        venueId,
        feeMode: 'CUSTOMER_PAYS',
      },
    })
  ).json();
  const session = await (
    await request.post(`${API}/events/${event.id}/sessions`, {
      headers: auth,
      data: {
        startsAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 60 * 86_400_000 + 2 * 3_600_000).toISOString(),
      },
    })
  ).json();
  const ticketType = await (
    await request.post(`${API}/events/ticket-types`, {
      headers: auth,
      data: {
        eventSessionId: session.id,
        name: 'General',
        priceMinor: 5000,
        quantityTotal: 50,
        maxPerOrder: 4,
      },
    })
  ).json();
  await request.post(`${API}/events/${event.id}/submit`, { headers: auth });
  const admin = await apiLogin(request, 'admin@eticketsgo.test');
  await request.post(`${API}/admin/events/${event.id}/review`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { decision: 'APPROVE' },
  });
  return { slug: event.slug, sessionId: session.id, ticketTypeId: ticketType.id };
}

test.describe('WCAG 2.2.1 — the booking hold can be extended', () => {
  test.describe.configure({ mode: 'serial' });

  let fx: Paid;
  let tokens: Awaited<ReturnType<typeof apiLogin>>;
  let buyerEmail: string;

  test.beforeAll(async ({ request }) => {
    fx = await paidEvent(request);
    buyerEmail = uniqueEmail('a11y_hold');
    await request.post(`${API}/auth/register`, {
      data: { email: buyerEmail, password: SEED_PASSWORD, fullName: 'Hold Tester' },
    });
    tokens = await apiLogin(request, buyerEmail);
  });

  test('the API grants more time, and says how much is left', async ({ request }) => {
    /*
      Asserted at the API rather than by waiting thirteen minutes for the banner to appear.
      The UI's job is to offer the action at the right moment; whether the action WORKS is a
      server question, and a test that sleeps for a countdown is a test nobody will run.
    */
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const booking = await (
      await request.post(`${API}/bookings`, {
        headers: auth,
        data: {
          eventSessionId: fx.sessionId,
          items: [{ ticketTypeId: fx.ticketTypeId, quantity: 1 }],
          buyerName: 'Hold Tester',
          buyerEmail,
        },
      })
    ).json();
    expect(booking.id, `booking failed: ${JSON.stringify(booking)}`).toBeTruthy();
    const before = new Date(booking.holdExpiresAt).getTime();

    const res = await request.post(`${API}/bookings/${booking.id}/extend-hold`, { headers: auth });
    const body = await res.json();
    expect(res.ok(), `extend failed: ${JSON.stringify(body)}`).toBe(true);

    expect(new Date(body.holdExpiresAt).getTime()).toBeGreaterThan(before - 1000);
    expect(body.holdExtensions).toBe(1);
    // The criterion asks for at least ten, and the UI needs to know when to stop offering.
    expect(body.maxHoldExtensions).toBeGreaterThanOrEqual(10);
    expect(body.extensionsRemaining).toBe(body.maxHoldExtensions - 1);
  });

  test('ten times, and then it stops', async ({ request }) => {
    /*
      Both halves matter. Fewer than ten does not satisfy the criterion; unbounded would let
      one person hold a sold-out show away from everybody else for as long as they liked,
      which is a different harm from the one the criterion prevents.
    */
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const booking = await (
      await request.post(`${API}/bookings`, {
        headers: auth,
        data: {
          eventSessionId: fx.sessionId,
          items: [{ ticketTypeId: fx.ticketTypeId, quantity: 1 }],
          buyerName: 'Hold Tester',
          buyerEmail,
        },
      })
    ).json();

    let last: { extensionsRemaining: number; maxHoldExtensions: number } | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await request.post(`${API}/bookings/${booking.id}/extend-hold`, { headers: auth });
      expect(r.ok(), `extension ${i + 1} was refused`).toBe(true);
      last = await r.json();
    }
    expect(last?.extensionsRemaining).toBe(0);

    const eleventh = await request.post(`${API}/bookings/${booking.id}/extend-hold`, {
      headers: auth,
    });
    expect(eleventh.status()).toBe(409);
    expect((await eleventh.json()).message).toMatch(/extended 10 times/i);
  });
});

test.describe('WCAG 1.4.10 — the storefront reflows at 320 pixels', () => {
  /*
    320 CSS pixels is the criterion's own number: a 1280px page at 400% zoom. What it forbids
    is having to scroll in TWO directions to read, which is what a fixed-width table or an
    unwrapped heading produces and what nothing in this repository was checking.

    Measured as documentElement.scrollWidth against the viewport, with a pixel of tolerance
    for sub-pixel rounding, because that is exactly the condition the criterion describes.
  */
  const ROUTES = ['/', '/events', '/login', '/pricing', '/help', '/fr-CA', '/fr-CA/events'];

  for (const route of ROUTES) {
    test(`${route} does not scroll sideways`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
      try {
        const page = await context.newPage();
        await page.goto(`${CUSTOMER}${route}`, { waitUntil: 'networkidle', timeout: 45_000 });
        const overflow = await page.evaluate(() => {
          const d = document.documentElement;
          return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth };
        });
        expect(
          overflow.scrollWidth,
          `${route} is ${overflow.scrollWidth}px wide in a ${overflow.clientWidth}px viewport, ` +
            `so it has to be scrolled in two directions to read (WCAG 1.4.10).`,
        ).toBeLessThanOrEqual(overflow.clientWidth + 1);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('WCAG 2.1.1 — a booking can be completed from the keyboard', () => {
  test.describe.configure({ mode: 'serial' });

  let fx: Paid;
  let tokens: Awaited<ReturnType<typeof apiLogin>>;

  test.beforeAll(async ({ request }) => {
    fx = await paidEvent(request);
    const email = uniqueEmail('a11y_kbd');
    await request.post(`${API}/auth/register`, {
      data: { email, password: SEED_PASSWORD, fullName: 'Keyboard Buyer' },
    });
    tokens = await apiLogin(request, email);
  });

  test('choose a ticket and reach the checkout without a mouse', async ({ page, context }) => {
    /*
      The criterion nobody was checking, and the one most likely to be found by an auditor
      first — because it is the first thing anybody testing accessibility actually does.

      Driven with real key presses rather than `.click()`, which dispatches a click event and
      proves nothing about whether the control can be REACHED. Tabbing until the target has
      focus is the honest version: if it is not in the tab order, this loop runs out and the
      test says so.
    */
    await seedBrowserAuth(context, tokens);
    await page.goto(`${CUSTOMER}/events/${fx.slug}`, { waitUntil: 'networkidle' });

    const quantity = page.locator('select[aria-label^="Quantity"]').first();
    await expect(quantity).toBeVisible({ timeout: 30_000 });

    const reached = await tabTo(page, quantity);
    expect(reached, 'the quantity control is not reachable by tabbing').toBe(true);
    await page.keyboard.press('ArrowDown');
    await expect(quantity).not.toHaveValue('0');

    const cta = page.getByRole('button', { name: /Continue to payment/ });
    const reachedCta = await tabTo(page, cta);
    expect(reachedCta, 'the checkout button is not reachable by tabbing').toBe(true);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/booking\/[^/]+\/payment/, { timeout: 30_000 });
  });
});

/**
 * Press Tab until `target` holds focus. Returns false if it never does.
 *
 * Bounded, because the failure this exists to catch — a control that is not in the tab order
 * at all — would otherwise be an infinite loop rather than a test result.
 */
async function tabTo(
  page: import('@playwright/test').Page,
  target: import('@playwright/test').Locator,
  maxPresses = 60,
): Promise<boolean> {
  for (let i = 0; i < maxPresses; i++) {
    const focused = await target.evaluate((el) => el === document.activeElement).catch(() => false);
    if (focused) return true;
    await page.keyboard.press('Tab');
  }
  return target.evaluate((el) => el === document.activeElement).catch(() => false);
}
