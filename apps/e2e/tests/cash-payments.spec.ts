import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth, SEED_PASSWORD, uniqueEmail } from './helpers';

/**
 * Paying cash at the counter.
 *
 * ── WHO ASKED FOR THIS, AND WHY IT MATTERS ─────────────────────────────────────────
 * "I came from village background where movie theaters take cash only — this product will
 * be really helpful for them who cannot build and pay for software vendors."
 *
 * A ticketing platform that insists on a card reader is unusable to exactly the venues that
 * most need somebody else's software. So a booking can be reserved online and paid for in
 * notes at the door.
 *
 * ── THE PROPERTY THE WHOLE DESIGN RESTS ON ─────────────────────────────────────────
 * The money never passes through the platform, so a cash booking must never look like money
 * the platform owes the organizer. It creates no Payment row, and settlement reads Payment
 * rows — asserted here against a real booking made through the API, because the unit suite
 * writes its own fixtures and can only check itself.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

async function cashEvent(request: APIRequestContext, accessToken: string) {
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
        title: `Cash Show ${stamp}`,
        category: 'Movie',
        venueId,
        feeMode: 'CUSTOMER_PAYS',
      },
    })
  ).json();
  const startsAt = new Date(Date.now() + 20 * 86_400_000);
  const session = await (
    await request.post(`${API}/events/${event.id}/sessions`, {
      headers: auth,
      data: {
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
    })
  ).json();
  await request.post(`${API}/events/ticket-types`, {
    headers: auth,
    data: {
      eventSessionId: session.id,
      name: 'Balcony',
      priceMinor: 12_000,
      quantityTotal: 100,
      maxPerOrder: 6,
    },
  });
  await request.post(`${API}/events/${event.id}/submit`, { headers: auth });
  const admin = await apiLogin(request, 'admin@eticketsgo.test');
  await request.post(`${API}/admin/events/${event.id}/review`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { decision: 'APPROVE' },
  });

  const detail = await (await request.get(`${API}/public/events/${event.slug}`)).json();
  const ticketTypeId = detail.sessions[0].ticketTypes[0].id;
  return {
    organizationId,
    eventId: event.id,
    slug: event.slug,
    sessionId: session.id,
    ticketTypeId,
    startsAt,
  };
}

test.describe('cash at the counter', () => {
  test.describe.configure({ mode: 'serial' });

  let owner: Awaited<ReturnType<typeof apiLogin>>;
  let buyer: Awaited<ReturnType<typeof apiLogin>>;
  let buyerEmail = '';
  /*
    Unique per run. Earlier runs leave their own reservations on the counter, so a fixed
    name matched four rows and the strict locator refused — the test was looking for "a Cash
    Buyer" when it meant "the one I just created".
  */
  const buyerName = `Cash Buyer ${Date.now()}`;
  let fx: Awaited<ReturnType<typeof cashEvent>>;
  let bookingId = '';

  test.beforeAll(async ({ request }) => {
    // Minted once — the auth throttle is deliberately tight and is not weakened for a test.
    owner = await apiLogin(request, ORGANIZER_EMAIL);
    fx = await cashEvent(request, owner.accessToken);

    buyerEmail = uniqueEmail('cashbuyer');
    await request.post(`${API}/auth/register`, {
      data: { email: buyerEmail, password: SEED_PASSWORD, fullName: buyerName },
    });
    buyer = await apiLogin(request, buyerEmail);

    /*
      Start from cash OFF, explicitly.

      Test 2 turns it on and it stays on, so a second run of this suite found test 1's
      precondition already false and failed for a reason that had nothing to do with the
      product. A suite that only passes once is a suite that will be believed once.
    */
    await request.patch(`${API}/organizations/${fx.organizationId}/cash-payments`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
      data: { enabled: false },
    });
  });

  test('1: cash is refused until the organizer turns it on', async ({ request }) => {
    /*
      The guard that stops anybody reserving seats for nothing. The client can ask for CASH;
      only the organization's own setting can grant it.
    */
    const res = await request.post(`${API}/bookings`, {
      headers: { Authorization: `Bearer ${buyer.accessToken}` },
      data: {
        eventSessionId: fx.sessionId,
        items: [{ ticketTypeId: fx.ticketTypeId, quantity: 1 }],
        buyerName,
        buyerEmail,
        paymentMethod: 'CASH',
      },
    });
    expect(res.ok()).toBe(false);
    expect((await res.json()).message).toMatch(/does not accept cash/i);
  });

  test('2: the owner turns it on from settings', async ({ page, context }) => {
    await seedBrowserAuth(context, owner);
    await page.goto(`${ORGANIZER}/organizer/settings`, { waitUntil: 'networkidle' });

    const toggle = page.getByLabel('Accept cash at the venue');
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    // Off unless somebody chooses it — taking money the platform never sees is not a default.
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(page.getByText(/Reservations now appear under Counter/i)).toBeVisible();
  });

  test('3: the buyer reserves, and is held until the show — not for fifteen minutes', async ({
    request,
  }) => {
    const res = await request.post(`${API}/bookings`, {
      headers: { Authorization: `Bearer ${buyer.accessToken}` },
      data: {
        eventSessionId: fx.sessionId,
        items: [{ ticketTypeId: fx.ticketTypeId, quantity: 1 }],
        buyerName,
        buyerEmail,
        paymentMethod: 'CASH',
      },
    });
    expect(res.ok(), `booking failed: ${await res.text()}`).toBe(true);
    const booking = await res.json();
    bookingId = booking.id;

    expect(booking.paymentMethod).toBe('CASH');
    expect(booking.status).toBe('PENDING_PAYMENT');
    /*
      No Payment row, and the response says so rather than reporting an empty one — a client
      that saw `payment: {}` would send the buyer to a checkout that cannot settle anything.
    */
    expect(booking.payment).toBeNull();

    /*
      The hold the unit suite deliberately does NOT assert, because there it would only be
      comparing a fixture with itself. Here the SERVICE chose it: a cash reservation runs to
      showtime, because a fifteen-minute hold expires before the customer has left the house.
    */
    const held = new Date(booking.holdExpiresAt).getTime();
    expect(held).toBeGreaterThan(Date.now() + 24 * 3_600_000);
    expect(held).toBe(fx.startsAt.getTime());
  });

  test('4: the counter shows it, and collecting issues the ticket', async ({ page, context }) => {
    await seedBrowserAuth(context, owner);
    await page.goto(`${ORGANIZER}/organizer/counter`, { waitUntil: 'networkidle' });

    // Said once, plainly, where the person taking the money will read it.
    await expect(page.getByText(/never passes through ETicketsGo/i)).toBeVisible({
      timeout: 30_000,
    });

    const row = page.getByRole('row', { name: new RegExp(buyerName) });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: /^Collect/ }).click();

    await expect(page.getByText(/Cash recorded/i)).toBeVisible({ timeout: 30_000 });
  });

  test('5: it is confirmed, ticketed, and still carries no Payment row', async ({ request }) => {
    /*
      Asserted against the API rather than the console: a table that renders a green badge
      proves nothing about whether a ticket exists or whether settlement now believes the
      platform owes somebody money.
    */
    const booking = await (
      await request.get(`${API}/bookings/${bookingId}`, {
        headers: { Authorization: `Bearer ${buyer.accessToken}` },
      })
    ).json();

    expect(booking.status).toBe('CONFIRMED');
    expect(booking.tickets.length).toBeGreaterThan(0);
    // The whole financial safety argument, after the money has actually changed hands.
    expect(booking.payment ?? null).toBeNull();
  });

  test('6: collecting again changes nothing', async ({ request }) => {
    // Two people at one counter will press the button twice. That must not issue a second
    // ticket, and must not read as an error to the person holding the notes.
    const res = await request.post(`${API}/payments/${bookingId}/collect-cash`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.ok()).toBe(true);
    expect((await res.json()).status).toBe('already_collected');

    const booking = await (
      await request.get(`${API}/bookings/${bookingId}`, {
        headers: { Authorization: `Bearer ${buyer.accessToken}` },
      })
    ).json();
    expect(booking.tickets).toHaveLength(1);
  });

  test('7: an online booking cannot be marked cash-collected', async ({ request }) => {
    /*
      Otherwise the button becomes a way to confirm a ticket nobody paid for through any
      channel we can see — and invisibly, because there is no provider record to contradict
      it.
    */
    const online = await (
      await request.post(`${API}/bookings`, {
        headers: { Authorization: `Bearer ${buyer.accessToken}` },
        data: {
          eventSessionId: fx.sessionId,
          items: [{ ticketTypeId: fx.ticketTypeId, quantity: 1 }],
          buyerName: 'Card Buyer',
          buyerEmail,
        },
      })
    ).json();

    const res = await request.post(`${API}/payments/${online.id}/collect-cash`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.ok()).toBe(false);
    expect((await res.json()).message).toMatch(/not a cash booking/i);
  });
});
