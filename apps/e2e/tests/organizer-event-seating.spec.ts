import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * Seating for an event that already exists, found from the event itself.
 *
 * The owner could not find seat-layout management for an existing event: the Sessions table
 * named a room and nothing else, and offered "Change" on shows that had already sold. This
 * walks the route a person takes - the event, its Seating view, the buyer's map - with roles
 * and labels only, then makes a real booking and checks the page says why the layout is now
 * locked, and to which version. The fixture is this spec's own and is uniquely named.
 */
type Auth = Record<string, string>;

async function fixture(request: APIRequestContext, auth: Auth) {
  const stamp = Date.now();
  const orgs = (await (await request.get(`${API}/organizations`, { headers: auth })).json()) as {
    id: string;
  }[];
  const organizationId = orgs[0].id;
  const venues = (await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json()) as { id: string }[];
  const venueId = venues[0].id;

  const space = await (
    await request.post(`${API}/venues/${venueId}/spaces`, {
      headers: auth,
      data: { name: `Seating Hall ${stamp}`, capacity: 16 },
    })
  ).json();
  const layout = await (
    await request.post(`${API}/screens/${space.id}/seatmap`, {
      headers: auth,
      data: {
        name: 'Recital',
        sections: [
          {
            name: 'Stalls',
            categoryName: 'Stalls',
            basePriceMinor: 40_000,
            rowLabels: ['A', 'B'],
            seatsPerRow: 8,
          },
        ],
      },
    })
  ).json();
  const title = `Seating View ${stamp}`;
  const event = await (
    await request.post(`${API}/events`, {
      headers: auth,
      data: { organizationId, title, category: 'Music', venueId, feeMode: 'CUSTOMER_PAYS' },
    })
  ).json();
  const start = Date.now() + 60 * 86_400_000;
  const session = await (
    await request.post(`${API}/events/${event.id}/sessions`, {
      headers: auth,
      data: {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 2 * 3_600_000).toISOString(),
        screenId: space.id,
        seatMapId: layout.id,
      },
    })
  ).json();
  return { eventId: event.id as string, sessionId: session.id as string, title };
}

test.describe('seating for an existing event', () => {
  test.describe.configure({ mode: 'serial' });
  let tokens: Awaited<ReturnType<typeof apiLogin>>;
  let fx: Awaited<ReturnType<typeof fixture>>;
  let auth: Auth;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, 'owner@eticketsgo.test');
    auth = { Authorization: `Bearer ${tokens.accessToken}` };
    fx = await fixture(request, auth);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('1: from the event, Seating names the space and version and previews the buyer map', async ({
    page,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/events/${fx.eventId}`);
    // The overview links into Seating with its live fact.
    const tile = page.getByRole('navigation', { name: 'Manage this event' });
    await expect(tile.getByRole('link', { name: /Seating/ })).toContainText('1 reserved seating', {
      timeout: 30_000,
    });
    await tile.getByRole('link', { name: /Seating/ }).click();
    await expect(page).toHaveURL(/\/seating$/);

    const show = page.getByRole('article').first();
    await expect(show).toContainText('Reserved seating', { timeout: 30_000 });
    await expect(show).toContainText(/Seating Hall \d+/);
    await expect(show).toContainText('Recital, version 1');
    await expect(show).toContainText('Stalls');
    // Unsold: the change is offered, through the existing endpoint's dialog.
    await expect(show.getByRole('button', { name: 'Change seating' })).toBeVisible();

    // A draft has no public seat read, so the preview is the layout itself, every seat free.
    const preview = show.getByRole('button', { name: 'Preview buyer seat map' });
    await preview.click();
    const dialog = page.getByRole('dialog', { name: /Buyer seat map/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('note')).toContainText('once the event is published');
    await expect(dialog.getByText(/stalls/i).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Focus goes back to the control that opened it.
    await expect(preview).toBeFocused();
  });

  test('2: after a booking the layout is locked, and the page says why in words', async ({
    page,
    request,
  }) => {
    const sub = await request.post(`${API}/events/${fx.eventId}/submit`, { headers: auth });
    expect(sub.ok(), await sub.text()).toBe(true);
    const admin = await apiLogin(request, 'admin@eticketsgo.test');
    const rev = await request.post(`${API}/admin/events/${fx.eventId}/review`, {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
      data: { decision: 'APPROVE' },
    });
    expect(rev.ok(), await rev.text()).toBe(true);

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
        buyerEmail: 'owner@eticketsgo.test',
      },
    });
    expect(booking.ok(), await booking.text()).toBe(true);
    const { id: bookingId } = await booking.json();
    // Paid where the environment has the mock provider; held otherwise. Either locks it.
    await request.post(`${API}/payments/${bookingId}/mock-pay`, {
      data: { outcome: 'succeeded' },
    });

    await page.goto(`${ORGANIZER}/organizer/events/${fx.eventId}/seating`);
    const show = page.getByRole('article').first();
    await expect(show).toContainText(
      /1 seat has been sold for this show, so its layout is locked to Recital, version 1\. Create a new show to use a different layout\.|1 seat is held in a checkout right now/,
      { timeout: 30_000 },
    );
    // No dead control: the change button is gone, replaced by the reason.
    await expect(show.getByRole('button', { name: 'Change seating' })).toHaveCount(0);

    // Published now, so the preview is the show's own map.
    await show.getByRole('button', { name: 'Preview buyer seat map' }).click();
    await expect(page.getByRole('dialog').getByRole('note')).toContainText(
      'seats already sold or held shown as taken',
    );
  });

  test('3: the list card has one Manage button and a keyboard-operable More menu', async ({
    page,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/events`);
    await page.getByPlaceholder('Search events…').fill(fx.title);
    const card = page.getByRole('article', { name: fx.title });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole('link', { name: `Manage ${fx.title}` })).toBeVisible();

    const more = card.getByRole('button', { name: `More actions for ${fx.title}` });
    await more.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    // Focus lands on the first item; arrows move; the booked event says why it cannot go.
    await expect(menu.getByRole('menuitem', { name: 'Edit details' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Seating' })).toBeFocused();
    await expect(menu).toContainText('This event has bookings, so it cannot be deleted');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();

    // Seating from the menu lands on the Seating view.
    await more.click();
    await page.getByRole('menuitem', { name: 'Seating' }).click();
    await expect(page).toHaveURL(new RegExp(`/organizer/events/${fx.eventId}/seating$`));
  });
});
