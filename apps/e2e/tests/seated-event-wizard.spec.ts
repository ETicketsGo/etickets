import { test, expect, type APIRequestContext } from '@playwright/test';
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
  const venueId = (Array.isArray(venues) ? venues : venues.data)[0].id;

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
  await request.post(`${API}/screens/${screen.id}/seatmap`, {
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
  return { organizationId, venueId, roomName: `Wizard Room ${stamp}`, screenId: screen.id };
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
  });

  test('1: the wizard offers the rooms, and creates the event seated', async ({
    page,
    request,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/events/new`, { waitUntil: 'networkidle' });

    await page.getByLabel('Event title').fill(`Wizard Seated ${Date.now()}`);
    await page.getByLabel('Category').selectOption('Music');
    // `exact` because the Next.js dev-tools button in the corner also matches "Next".
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByLabel('Venue').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    await page.locator('#ss0').fill(dayAfter(120));
    await page.locator('#ss0-time').selectOption('18:00');
    await page.locator('#se0').fill(dayAfter(120));
    await page.locator('#se0-time').selectOption('20:00');

    /*
      The control the complaint was about. Its default has to be general admission: every
      event created before this existed was general admission, and a wizard that quietly
      started seating them would change what thousands of drafts mean.
    */
    const seating = page.locator('#sr0');
    await expect(seating).toBeVisible();
    await expect(seating).toHaveValue('');
    await expect(page.getByText('Pick a room to sell numbered seats')).toBeVisible();

    await seating.selectOption(room.screenId);
    await expect(page.getByText('Buyers pick a named seat')).toBeVisible();

    await page.getByRole('button', { name: 'Next', exact: true }).click();

    /*
      No ticket-type form. A seated session gets one per seat category the moment it is
      created, priced from the category — asking the organizer to invent a second set would
      produce two conflicting prices for the same night, and the room's would silently win.
    */
    await expect(page.getByText('Ticket types come from the seat map')).toBeVisible();
    await expect(page.locator('#tn0')).toHaveCount(0);

    await page.getByRole('button', { name: 'Next', exact: true }).click(); // fee handling
    await page.getByRole('button', { name: 'Next', exact: true }).click(); // review

    // Named, not counted: booking a run into the wrong auditorium is what this page catches.
    await expect(page.getByText(`Assigned seats — ${room.roomName}`)).toBeVisible();

    await page.getByRole('button', { name: 'Save draft' }).click();
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

    await page.getByLabel('Event title').fill(`Wizard Standing ${Date.now()}`);
    await page.getByLabel('Category').selectOption('Music');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByLabel('Venue').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.locator('#ss0').fill(dayAfter(121));
    await page.locator('#ss0-time').selectOption('18:00');
    await page.locator('#se0').fill(dayAfter(121));
    await page.locator('#se0-time').selectOption('20:00');
    await page.getByRole('button', { name: 'Next', exact: true }).click();

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

function dayAfter(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
