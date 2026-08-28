import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, CUSTOMER, apiLogin, seedBrowserAuth, SEED_PASSWORD, uniqueEmail } from './helpers';

/**
 * A concert with assigned seats, from the seat map to the ticket.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────────────
 * Reserved seating used to exist only for cinemas: a seat map hung off a screen, a screen
 * belonged to a cinema, and the booking path decided seat-based versus general admission
 * purely on whether the experience was a MOVIE. A theatre selling assigned seats for a
 * concert could only sell numbered quantities of a ticket type.
 *
 * Whether a ticket names a seat is a property of the ROOM. A session has one or it does not,
 * and the same concert is reserved seating in a theatre and general admission in a standing
 * arena. This walks the whole path on a non-movie event to prove the machinery the cinema
 * flow already had now serves both.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

interface Seated {
  slug: string;
  sessionId: string;
  screenId: string;
}

/** A published concert in a room with a published layout. */
async function seatedConcert(request: APIRequestContext): Promise<Seated> {
  const { accessToken } = await apiLogin(request, ORGANIZER_EMAIL);
  const auth = { Authorization: `Bearer ${accessToken}` };
  const stamp = Date.now();

  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const venues = await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const venueId = (Array.isArray(venues) ? venues : venues.data)[0].id;

  // A room of its own, so repeated runs never fight over seats.
  const cinema = await (
    await request.post(`${API}/cinemas`, {
      headers: auth,
      data: { organizationId, venueId, name: `Concert Hall ${stamp}`, city: 'Hyderabad' },
    })
  ).json();
  const screen = await (
    await request.post(`${API}/cinemas/${cinema.id}/screens`, {
      headers: auth,
      data: { name: `Auditorium ${stamp}`, screenType: '2D', capacity: 24 },
    })
  ).json();
  await request.post(`${API}/screens/${screen.id}/seatmap`, {
    headers: auth,
    data: {
      name: 'Auditorium',
      sections: [
        {
          name: 'Stalls',
          categoryName: 'Stalls',
          basePriceMinor: 30_000,
          rowLabels: ['A', 'B'],
          seatsPerRow: 6,
        },
      ],
    },
  });

  const event = await (
    await request.post(`${API}/events`, {
      headers: auth,
      data: {
        organizationId,
        title: `Seated Concert ${stamp}`,
        category: 'Music',
        venueId,
        feeMode: 'CUSTOMER_PAYS',
      },
    })
  ).json();
  expect(event.id, `event creation failed: ${JSON.stringify(event)}`).toBeTruthy();

  /*
    The session names the room, and that is the ENTIRE difference. No ticket types are sent:
    they are derived from the room's seat categories, because a seat's price comes from where
    it is in the room rather than from something typed on the event.
  */
  const sessionRes = await request.post(`${API}/events/${event.id}/sessions`, {
    headers: auth,
    data: {
      startsAt: new Date(Date.now() + 70 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 70 * 86_400_000 + 3 * 3_600_000).toISOString(),
      screenId: screen.id,
    },
  });
  const session = await sessionRes.json();
  expect(sessionRes.ok(), `session creation failed: ${JSON.stringify(session)}`).toBe(true);

  await request.post(`${API}/events/${event.id}/submit`, { headers: auth });
  const admin = await apiLogin(request, 'admin@eticketsgo.test');
  await request.post(`${API}/admin/events/${event.id}/review`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { decision: 'APPROVE' },
  });

  return { slug: event.slug, sessionId: session.id, screenId: screen.id };
}

test.describe('a concert with assigned seats', () => {
  test.describe.configure({ mode: 'serial' });

  let fx: Seated;
  let tokens: Awaited<ReturnType<typeof apiLogin>>;
  let buyerEmail: string;

  test.beforeAll(async ({ request }) => {
    fx = await seatedConcert(request);
    buyerEmail = uniqueEmail('seated_buyer');
    await request.post(`${API}/auth/register`, {
      data: { email: buyerEmail, password: SEED_PASSWORD, fullName: 'Seat Buyer' },
    });
    tokens = await apiLogin(request, buyerEmail);
  });

  test('1: the room gives the session its seats and its prices', async ({ request }) => {
    /*
      A ticket type per seat category, priced from the category, with a quantity counted from
      the seats actually drawn — not from the room's stated capacity, because a room described
      as holding twenty-four seats but drawn with aisles sells fewer, and the drawing is what
      admits people.
    */
    const detail = await (await request.get(`${API}/public/events/${fx.slug}`)).json();
    const session = detail.sessions.find((s: { id: string }) => s.id === fx.sessionId);

    expect(session.seatBased, 'the public payload must say the session is seated').toBe(true);
    expect(session.ticketTypes).toHaveLength(1);
    expect(session.ticketTypes[0].name).toBe('Stalls');
    expect(session.ticketTypes[0].priceMinor).toBe(30_000);
    expect(session.ticketTypes[0].available).toBe(12);
  });

  test('2: the seat map is readable by a customer', async ({ request }) => {
    // The same public read the cinema flow uses. It was never movie-gated; what it needed
    // was a session with a pinned layout, which a seated event now has.
    const res = await request.get(`${API}/public/shows/${fx.sessionId}/seats`);
    const layout = await res.json();
    expect(res.ok(), `seat read failed: ${JSON.stringify(layout)}`).toBe(true);

    const seats = layout.sections
      .flatMap((s: { rows: { seats: unknown[] }[] }) => s.rows)
      .flatMap((r: { seats: { label: string; status: string }[] }) => r.seats);
    expect(seats).toHaveLength(12);
    expect(seats.every((s: { status: string }) => s.status === 'AVAILABLE')).toBe(true);
  });

  test('3: booking names the seat, and a second buyer cannot take it', async ({ request }) => {
    /*
      The guarantee that matters. Reserved seating is only reserved if the second person to
      ask is refused — and this is the machinery the cinema flow already had, now reached by
      an event, so what is really under test is that it was reached at all.
    */
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const layout = await (await request.get(`${API}/public/shows/${fx.sessionId}/seats`)).json();
    const ticketTypeId = layout.categories[0].ticketTypeId;
    const firstSeat = layout.sections[0].rows[0].seats[0];

    const booking = await (
      await request.post(`${API}/bookings`, {
        headers: auth,
        data: {
          eventSessionId: fx.sessionId,
          items: [{ ticketTypeId, quantity: 1, seatIds: [firstSeat.id] }],
          buyerName: 'Seat Buyer',
          buyerEmail,
        },
      })
    ).json();
    expect(booking.id, `seated booking failed: ${JSON.stringify(booking)}`).toBeTruthy();

    // Somebody else asking for the same seat is refused, not queued behind it.
    const rival = uniqueEmail('seated_rival');
    await request.post(`${API}/auth/register`, {
      data: { email: rival, password: SEED_PASSWORD, fullName: 'Rival' },
    });
    const rivalTokens = await apiLogin(request, rival);
    const clash = await request.post(`${API}/bookings`, {
      headers: { Authorization: `Bearer ${rivalTokens.accessToken}` },
      data: {
        eventSessionId: fx.sessionId,
        items: [{ ticketTypeId, quantity: 1, seatIds: [firstSeat.id] }],
        buyerName: 'Rival',
        buyerEmail: rival,
      },
    });
    expect(clash.ok(), 'the same seat was sold twice').toBe(false);
  });

  test('4: asking for a quantity without saying which seat is refused', async ({ request }) => {
    /*
      "Two of Stalls" is not a booking on a seated show — it is a booking with the important
      part missing. Refusing it is what stops a buyer paying before anybody has decided where
      they sit, and it is why the storefront sends them to the map instead of a quantity box.
    */
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const layout = await (await request.get(`${API}/public/shows/${fx.sessionId}/seats`)).json();
    const res = await request.post(`${API}/bookings`, {
      headers: auth,
      data: {
        eventSessionId: fx.sessionId,
        items: [{ ticketTypeId: layout.categories[0].ticketTypeId, quantity: 2 }],
        buyerName: 'Seat Buyer',
        buyerEmail,
      },
    });
    expect(res.ok()).toBe(false);
    expect((await res.json()).message).toMatch(/select a seat for each ticket/i);
  });

  test('5: the storefront sends the buyer to the seat map, not a quantity box', async ({
    page,
    context,
  }) => {
    await seedBrowserAuth(context, tokens);
    await page.goto(`${CUSTOMER}/events/${fx.slug}`, { waitUntil: 'networkidle' });

    await expect(page.getByRole('heading', { name: 'Choose your seats' })).toBeVisible({
      timeout: 30_000,
    });
    // The quantity control must be absent: offering one would let somebody commit to a price
    // without saying which seats, and be refused at the last step.
    await expect(page.locator('select[aria-label^="Quantity"]')).toHaveCount(0);

    await page.getByRole('link', { name: 'Choose seats' }).click();
    await expect(page).toHaveURL(new RegExp(`/shows/${fx.sessionId}`), { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^Seat A1/ })).toBeVisible({ timeout: 30_000 });
  });

  test('6: an event with no room still sells quantities', async ({ page, context, request }) => {
    /*
      The whole change is additive, and this is the half that proves it. A general-admission
      event must behave exactly as it did — no seat map, no redirect, a quantity box.
    */
    const { accessToken } = await apiLogin(request, ORGANIZER_EMAIL);
    const auth = { Authorization: `Bearer ${accessToken}` };
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
          title: `Standing Show ${Date.now()}`,
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
          startsAt: new Date(Date.now() + 71 * 86_400_000).toISOString(),
          endsAt: new Date(Date.now() + 71 * 86_400_000 + 3 * 3_600_000).toISOString(),
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
    await request.post(`${API}/events/${event.id}/submit`, { headers: auth });
    const admin = await apiLogin(request, 'admin@eticketsgo.test');
    await request.post(`${API}/admin/events/${event.id}/review`, {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
      data: { decision: 'APPROVE' },
    });

    await seedBrowserAuth(context, tokens);
    await page.goto(`${CUSTOMER}/events/${event.slug}`, { waitUntil: 'networkidle' });
    await expect(page.locator('select[aria-label^="Quantity"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('heading', { name: 'Choose your seats' })).toHaveCount(0);
  });
});
