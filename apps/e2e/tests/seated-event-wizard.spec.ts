import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * Choosing a seat map while creating an event.
 *
 * ── THE COMPLAINT THIS ANSWERS ─────────────────────────────────────────────────────
 * "I do not see seat map or layout while creating event."
 *
 * They were right, and it was not a missing control — the wizard had nothing to offer. Seat
 * maps hung off cinema screens and the booking path decided reserved-versus-general purely on
 * whether the experience was a MOVIE, so a theatre selling assigned seats for a concert could
 * only sell numbered quantities.
 *
 * The room is now the whole difference, and it is chosen where the sessions are, because that
 * is where the choice actually belongs: a run of shows can move between an auditorium and a
 * studio, and the same event is reserved seating in one and general admission in the other.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

/** A room in the organizer's own org with a published layout, so the picker has something. */
async function roomWithSeats(request: APIRequestContext, accessToken: string) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const stamp = Date.now();

  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const venues = await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const venue = (Array.isArray(venues) ? venues : venues.data)[0];
  const venueId = venue.id;

  const cinema = await (
    await request.post(`${API}/cinemas`, {
      headers: auth,
      data: { organizationId, venueId, name: `Wizard Hall ${stamp}`, city: 'Hyderabad' },
    })
  ).json();
  const screen = await (
    await request.post(`${API}/cinemas/${cinema.id}/screens`, {
      headers: auth,
      data: { name: `Wizard Room ${stamp}`, screenType: '2D', capacity: 20 },
    })
  ).json();
  const mapResponse = await request.post(`${API}/screens/${screen.id}/seatmap`, {
    headers: auth,
    data: {
      name: 'Wizard layout',
      sections: [
        {
          name: 'Stalls',
          categoryName: 'Stalls',
          basePriceMinor: 45_000,
          rowLabels: ['A', 'B'],
          seatsPerRow: 5,
        },
      ],
    },
  });
  const map = await mapResponse.json();
  expect(mapResponse.ok(), `seat-map creation failed: ${JSON.stringify(map)}`).toBe(true);
  const roomsResponse = await request.get(
    `${API}/events/seating-rooms?organizationId=${organizationId}`,
    { headers: auth },
  );
  const rooms = await roomsResponse.json();
  expect(roomsResponse.ok(), `seating-room lookup failed: ${JSON.stringify(rooms)}`).toBe(true);
  expect(
    rooms.some(
      (room: { id: string; layoutId: string }) => room.id === screen.id && room.layoutId === map.id,
    ),
  ).toBe(true);
  return {
    organizationId,
    venueId,
    venueName: venue.name as string,
    roomName: `Wizard Room ${stamp}`,
    screenId: screen.id,
    layoutId: map.id as string,
  };
}

test.describe('creating an event with assigned seating', () => {
  test.describe.configure({ mode: 'serial' });

  let tokens: Awaited<ReturnType<typeof apiLogin>>;
  let room: Awaited<ReturnType<typeof roomWithSeats>>;

  test.beforeAll(async ({ request }) => {
    // Minted once — the auth throttle is deliberately tight and is not weakened for a test.
    tokens = await apiLogin(request, ORGANIZER_EMAIL);
    room = await roomWithSeats(request, tokens.accessToken);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
    await context.addInitScript((organizationId) => {
      localStorage.setItem('etg_active_org', organizationId);
    }, room.organizationId);
  });

  test('1: the wizard offers the rooms, and creates the event seated', async ({
    page,
    request,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/events/new`, { waitUntil: 'networkidle' });
    await whereAndWhen(page, `Wizard Seated ${Date.now()}`, room.venueName, 120);

    /*
      The control the complaint was about, now one of the three answers to "How do people get
      in?". Nothing is chosen by default: every event created before this existed was general
      admission, and a wizard that quietly started seating them would change what drafts mean.
      It is offered because THIS venue has a space with a published seat map.
    */
    const seated = page.getByRole('radio', { name: 'Reserved seating' });
    await expect(seated).toBeEnabled();
    await expect(seated).not.toBeChecked();
    await seated.check();
    await page.getByLabel('Seat map').selectOption(room.layoutId);

    /*
      No ticket-type form. A seated session gets one per seat category the moment it is
      created, priced from the category — asking the organizer to invent a second set would
      produce two conflicting prices for the same night, and the room's would silently win.
    */
    await expect(page.getByText('Ticket types come from the seat map')).toBeVisible();
    await expect(page.locator('#tn0')).toHaveCount(0);

    await page.getByRole('button', { name: 'Continue' }).click(); // details - nothing required
    await page.getByRole('button', { name: 'Continue' }).click(); // review

    // Named, not counted: booking a run into the wrong auditorium is what this page catches.
    await expect(page.getByText(`Assigned seats: ${room.roomName}`)).toBeVisible();

    await page.getByRole('button', { name: 'Create draft event' }).click();
    // `[^/]+` alone also matches /organizer/events/NEW, so it would pass without a redirect.
    await expect(page).toHaveURL(/\/organizer\/events\/(?!new$)[^/]+$/, { timeout: 30_000 });

    /*
      What was WRITTEN, not what the review screen said. The wizard could render every one of
      the assertions above and still send the session without its room.
    */
    const eventId = page.url().split('/').pop()!;
    const res = await request.get(`${API}/events/${eventId}`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const detail = await res.json();
    expect(res.ok(), `GET /events/${eventId} → ${res.status()} ${JSON.stringify(detail)}`).toBe(
      true,
    );
    expect(detail.sessions[0].screenId).toBe(room.screenId);
    // One ticket type, from the room's one seat category, at the category's price.
    expect(detail.sessions[0].ticketTypes).toHaveLength(1);
    expect(detail.sessions[0].ticketTypes[0].name).toBe('Stalls');
    expect(detail.sessions[0].ticketTypes[0].priceMinor).toBe(45_000);
    // Ten positions drawn, none of them aisles.
    expect(detail.sessions[0].ticketTypes[0].quantityTotal).toBe(10);
  });

  test('2: leaving it general admission still asks for ticket types', async ({ page }) => {
    // The half that proves the change is additive: the wizard an organizer already knows must
    // behave exactly as it did when they do not touch the new control.
    await page.goto(`${ORGANIZER}/organizer/events/new`, { waitUntil: 'networkidle' });
    await whereAndWhen(page, `Wizard Standing ${Date.now()}`, room.venueName, 121);

    // Nothing about tickets is asked until the organizer says how people get in.
    await expect(page.locator('#tn0')).toHaveCount(0);
    await page.getByRole('radio', { name: 'Paid - general admission' }).check();
    await expect(page.locator('#tn0')).toBeVisible();
    await expect(page.getByText('Ticket types come from the seat map')).toHaveCount(0);
  });

  test('3: the schedule says which room a session is in', async ({ page, request }) => {
    /*
      Not just THAT it is seated. "Reserved seating" alone repeats what the organizer already
      knew; the room is the fact they open the schedule to check, and the one that catches a
      session booked into the wrong auditorium while it can still be removed.
    */
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const event = await (
      await request.post(`${API}/events`, {
        headers: auth,
        data: {
          organizationId: room.organizationId,
          title: `Schedule Seated ${Date.now()}`,
          category: 'Music',
          venueId: room.venueId,
          feeMode: 'CUSTOMER_PAYS',
        },
      })
    ).json();
    await request.post(`${API}/events/${event.id}/sessions`, {
      headers: auth,
      data: {
        startsAt: new Date(Date.now() + 130 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 130 * 86_400_000 + 2 * 3_600_000).toISOString(),
        screenId: room.screenId,
      },
    });

    await page.goto(`${ORGANIZER}/organizer/events/${event.id}/sessions`, {
      waitUntil: 'networkidle',
    });
    /*
      Scoped to the table cell. The room's name also appears in the "Add session" picker on
      the same page, so an unscoped text match finds two elements and fails for a reason that
      has nothing to do with what the schedule says.
    */
    const cell = page.getByRole('cell', { name: new RegExp(room.roomName) });
    await expect(cell).toBeVisible({ timeout: 30_000 });
    await expect(cell).toContainText('Reserved seating');
  });
});

/**
 * A concert, through the first two steps to the tickets, by visible labels only: the venue is
 * found by searching its name, and the time is set with the "+2h" shortcut.
 */
async function whereAndWhen(page: Page, title: string, venueName: string, days: number) {
  await page.getByRole('radio', { name: 'Concert or live music' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Event title').fill(title);
  await page.getByRole('button', { name: 'Continue' }).click();
  const search = page.getByLabel('Search your venues');
  if (await search.isVisible()) await search.fill(venueName);
  await page.getByRole('radio', { name: venueName, exact: true }).check();
  const start = page
    .getByRole('group', { name: 'Performance 1' })
    .getByRole('group', { name: 'Starts at' });
  await start.getByLabel('Date').fill(dayAfter(days));
  await start.getByLabel('Time').selectOption('18:00');
  await page.getByRole('button', { name: '+2h' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
}

function dayAfter(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
