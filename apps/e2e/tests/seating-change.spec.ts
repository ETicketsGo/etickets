import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * Changing a session's seating after the session exists.
 *
 * ── THE OBSTACLE THIS REMOVES ──────────────────────────────────────────────────────
 * Seating was choosable only when a session was created. That was a deliberate call — a
 * session with sold tickets cannot be re-seated, because it would move seats people have
 * already paid for — but it was applied to EVERY session, including the overwhelming
 * majority that have sold nothing at all.
 *
 * So an organizer who created an event, then realised it should have assigned seating, found
 * no way to say so: the only route was to delete the session and build it again. That is
 * friction with no safety argument behind it, and it is what somebody hit while testing.
 *
 * The rule is now the honest one: change it freely until the first commitment, refuse
 * afterwards and say why.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

async function fixture(request: APIRequestContext, accessToken: string) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const stamp = Date.now();

  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const venues = await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const venueId = (Array.isArray(venues) ? venues : venues.data)[0].id;

  const cinema = await (
    await request.post(`${API}/cinemas`, {
      headers: auth,
      data: { organizationId, venueId, name: `Move Hall ${stamp}`, city: 'Hyderabad' },
    })
  ).json();
  const screen = await (
    await request.post(`${API}/cinemas/${cinema.id}/screens`, {
      headers: auth,
      data: { name: `Move Room ${stamp}`, screenType: '2D', capacity: 20 },
    })
  ).json();
  await request.post(`${API}/screens/${screen.id}/seatmap`, {
    headers: auth,
    data: {
      name: 'Move layout',
      sections: [
        {
          name: 'Stalls',
          categoryName: 'Stalls',
          basePriceMinor: 25_000,
          rowLabels: ['A', 'B'],
          seatsPerRow: 4,
        },
      ],
    },
  });

  // A general-admission event with one session and one hand-typed ticket type — exactly the
  // state somebody is in when they realise they wanted assigned seating.
  const event = await (
    await request.post(`${API}/events`, {
      headers: auth,
      data: {
        organizationId,
        title: `Move Me ${stamp}`,
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
        startsAt: new Date(Date.now() + 80 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 80 * 86_400_000 + 3 * 3_600_000).toISOString(),
      },
    })
  ).json();
  await request.post(`${API}/events/ticket-types`, {
    headers: auth,
    data: {
      eventSessionId: session.id,
      name: 'General',
      priceMinor: 20_000,
      quantityTotal: 100,
      maxPerOrder: 6,
    },
  });

  return {
    organizationId,
    eventId: event.id,
    sessionId: session.id,
    screenId: screen.id,
    roomName: `Move Room ${stamp}`,
  };
}

test.describe('changing seating on a session that exists', () => {
  test.describe.configure({ mode: 'serial' });

  let tokens: Awaited<ReturnType<typeof apiLogin>>;
  let fx: Awaited<ReturnType<typeof fixture>>;

  test.beforeAll(async ({ request }) => {
    // Minted once — the auth throttle is deliberately tight and is not weakened for a test.
    tokens = await apiLogin(request, ORGANIZER_EMAIL);
    fx = await fixture(request, tokens.accessToken);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('1: the organizer turns a general-admission session into a seated one', async ({
    page,
    request,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/events/${fx.eventId}/sessions`, {
      waitUntil: 'networkidle',
    });

    await expect(page.getByRole('cell', { name: /General admission/ })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Change' }).first().click();

    /*
      The consequence is stated BEFORE it happens. Changing seating replaces the session's
      ticket types, and one was typed by hand here — discovering that afterwards is how
      somebody stops trusting the console.
    */
    await page.getByLabel('Seating').last().selectOption(fx.screenId);
    await expect(page.getByText(/1 ticket type will be replaced/)).toBeVisible();

    await page.getByRole('button', { name: 'Use this room' }).click();
    await expect(page.getByRole('cell', { name: new RegExp(fx.roomName) })).toBeVisible({
      timeout: 30_000,
    });

    // What was WRITTEN, not what the table says — the UI could render every assertion above
    // and still have sent nothing.
    const detail = await (
      await request.get(`${API}/events/${fx.eventId}`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
    ).json();
    const session = detail.sessions.find((s: { id: string }) => s.id === fx.sessionId);
    expect(session.screenId).toBe(fx.screenId);
    // Replaced, not merged: the hand-typed 'General' is gone, the room's category is there.
    expect(session.ticketTypes).toHaveLength(1);
    expect(session.ticketTypes[0].name).toBe('Stalls');
    expect(session.ticketTypes[0].priceMinor).toBe(25_000);
    expect(session.ticketTypes[0].quantityTotal).toBe(8);
  });

  test('2: and back again, because it is a setting rather than a one-way door', async ({
    page,
    request,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/events/${fx.eventId}/sessions`, {
      waitUntil: 'networkidle',
    });
    await page.getByRole('button', { name: 'Change' }).first().click();
    await page.getByLabel('Seating').last().selectOption('');
    await page.getByRole('button', { name: 'Make it general admission' }).click();

    await expect(page.getByRole('cell', { name: /General admission/ })).toBeVisible({
      timeout: 30_000,
    });

    const detail = await (
      await request.get(`${API}/events/${fx.eventId}`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
    ).json();
    const session = detail.sessions.find((s: { id: string }) => s.id === fx.sessionId);
    expect(session.screenId).toBeFalsy();
    expect(session.ticketTypes).toHaveLength(0);
  });

  test('3: once a seat is sold the room is fixed, and the refusal says why', async ({
    request,
  }) => {
    /*
      The line the whole feature rests on, checked through the API because what matters is
      that the SERVER refuses — a UI that merely hides the button would still be one crafted
      request away from moving seats somebody paid for.
    */
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    await request.patch(`${API}/events/sessions/${fx.sessionId}/seating`, {
      headers: auth,
      data: { screenId: fx.screenId },
    });

    /*
      Published here rather than in the fixture. Tests 1 and 2 need a DRAFT — which is the
      state an organizer is actually in when they change their mind about seating — and
      publishing it up front would have exercised a different, rarer situation.
    */
    const sub = await request.post(`${API}/events/${fx.eventId}/submit`, { headers: auth });
    expect(sub.ok(), `submit failed: ${await sub.text()}`).toBe(true);
    const admin = await apiLogin(request, 'admin@eticketsgo.test');
    const rev = await request.post(`${API}/admin/events/${fx.eventId}/review`, {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
      data: { decision: 'APPROVE' },
    });
    expect(rev.ok(), `review failed: ${await rev.text()}`).toBe(true);

    // A real booking, made the way a customer makes one.
    const layout = await (await request.get(`${API}/public/shows/${fx.sessionId}/seats`)).json();
    const seat = layout.sections[0].rows[0].seats[0];
    const booking = await request.post(`${API}/bookings`, {
      headers: auth,
      data: {
        eventSessionId: fx.sessionId,
        items: [
          { ticketTypeId: layout.categories[0].ticketTypeId, quantity: 1, seatIds: [seat.id] },
        ],
        buyerName: 'Seat Holder',
        buyerEmail: ORGANIZER_EMAIL,
      },
    });
    expect(booking.ok(), `booking failed: ${await booking.text()}`).toBe(true);

    const refused = await request.patch(`${API}/events/sessions/${fx.sessionId}/seating`, {
      headers: auth,
      data: { screenId: null },
    });
    expect(refused.ok()).toBe(false);
    const body = await refused.json();
    // Not merely refused — the message names the number, because "you can't" without
    // "because one booking exists" is indistinguishable from a broken button.
    expect(body.message).toMatch(/already has 1 booking|1 ticket sold|currently held/i);
  });
});
