import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * Deleting an event: possible while nobody has booked it, refused once somebody has.
 *
 * Only events this spec creates are ever deleted — the storefront specs depend on the seeded
 * catalogue.
 */
type Auth = Record<string, string>;

async function firstOrg(request: APIRequestContext, auth: Auth) {
  const orgs = (await (await request.get(`${API}/organizations`, { headers: auth })).json()) as {
    id: string;
  }[];
  return orgs[0].id;
}

async function makeEvent(request: APIRequestContext, auth: Auth, organizationId: string) {
  const venues = (await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json()) as { id: string }[];
  const title = `Delete me ${Date.now()}`;
  const res = await request.post(`${API}/events`, {
    headers: auth,
    data: {
      organizationId,
      venueId: venues[0].id,
      title,
      category: 'Music',
      feeMode: 'CUSTOMER_PAYS',
    },
  });
  expect(res.ok()).toBe(true);
  const event = (await res.json()) as { id: string };
  return { id: event.id, title };
}

test.describe('deleting an event', () => {
  test('an event with no bookings is deleted from the events list', async ({
    browser,
    request,
  }) => {
    const tokens = await apiLogin(request, 'owner@eticketsgo.test');
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const organizationId = await firstOrg(request, auth);
    const event = await makeEvent(request, auth, organizationId);

    const context = await browser.newContext();
    await seedBrowserAuth(context, tokens);
    const page = await context.newPage();
    await page.goto(`${ORGANIZER}/organizer/events`);
    await page.getByPlaceholder('Search events…').fill(event.title);

    await page.getByRole('button', { name: `Delete ${event.title}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this event?' });
    await expect(dialog).toContainText(event.title);
    await dialog.getByRole('button', { name: 'Delete event' }).click();

    await expect(page.getByText('Event deleted.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(event.title)).toHaveCount(0);
    const gone = await request.get(`${API}/events/${event.id}`, { headers: auth });
    expect(gone.status()).toBe(404);

    await context.close();
  });

  test('an event with bookings cannot be deleted, and says why', async ({ request }) => {
    const tokens = await apiLogin(request, 'owner@eticketsgo.test');
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const organizationId = await firstOrg(request, auth);
    const events = (await (
      await request.get(`${API}/events?organizationId=${organizationId}`, { headers: auth })
    ).json()) as { id: string; _count: { bookings: number } }[];
    const booked = events.find((e) => e._count.bookings > 0);
    test.skip(!booked, 'no seeded event with bookings');

    const res = await request.delete(`${API}/events/${booked!.id}`, { headers: auth });
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/cannot be deleted/);
    const still = await request.get(`${API}/events/${booked!.id}`, { headers: auth });
    expect(still.ok()).toBe(true);
  });
});
