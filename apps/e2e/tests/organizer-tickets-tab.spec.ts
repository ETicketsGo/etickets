import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * The event's Tickets page: adding a ticket type never meets a dead button.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * "Add ticket type" stayed greyed out until a session was picked from a dropdown - even on an
 * event with ONE session - and nothing said why. The page also said "Session" and "Quantity"
 * where the create wizard says "Performance" / "Match" and "Quantity on sale".
 *
 * ── WHAT IS PROVEN HERE ────────────────────────────────────────────────────────────
 * 1. One session: it is chosen for you and named; fill the fields, Add, and the ticket type
 *    exists on that session with exactly the values the page always sent.
 * 2. Several sessions: the reason is on the screen before anyone presses anything; pressing Add
 *    anyway says "Select a match." under the picker and puts the cursor on it; choosing one and
 *    adding creates the ticket type on THAT match. A match's own "Add ticket type" button
 *    chooses that match.
 *
 * Each test makes its own draft event and deletes it afterwards: the local database is shared.
 */

const ORGANIZER_EMAIL = 'owner@eticketsgo.test';
const DAY = 86_400_000;

let tokens: AuthTokens;
let auth: { Authorization: string };
const created: string[] = [];

async function draftEvent(
  request: APIRequestContext,
  title: string,
  category: string,
  sessionCount: number,
): Promise<{ eventId: string; sessionIds: string[] }> {
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const venues = await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const venueId = (Array.isArray(venues) ? venues : venues.data)[0].id;
  const res = await request.post(`${API}/events`, {
    headers: auth,
    data: { organizationId, title, category, venueId, feeMode: 'CUSTOMER_PAYS' },
  });
  const event = await res.json();
  expect(event.id, `event creation failed: ${JSON.stringify(event)}`).toBeTruthy();
  created.push(event.id);
  const sessionIds: string[] = [];
  for (let i = 0; i < sessionCount; i++) {
    const start = Date.now() + (40 + i) * DAY;
    const session = await (
      await request.post(`${API}/events/${event.id}/sessions`, {
        headers: auth,
        data: {
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + 2 * 3_600_000).toISOString(),
        },
      })
    ).json();
    expect(session.id, `session creation failed: ${JSON.stringify(session)}`).toBeTruthy();
    sessionIds.push(session.id);
  }
  return { eventId: event.id, sessionIds };
}

/** The ticket types on each session, read back from the API rather than from the page. */
async function ticketTypesBySession(request: APIRequestContext, eventId: string) {
  const event = await (await request.get(`${API}/events/${eventId}`, { headers: auth })).json();
  return Object.fromEntries(
    (event.sessions as { id: string; ticketTypes?: Record<string, unknown>[] }[]).map((s) => [
      s.id,
      s.ticketTypes ?? [],
    ]),
  );
}

test.beforeAll(async ({ request }) => {
  // One sign-in for the file: the auth throttle counts requests, not people.
  tokens = await apiLogin(request, ORGANIZER_EMAIL);
  auth = { Authorization: `Bearer ${tokens.accessToken}` };
});

test.afterAll(async ({ request }) => {
  for (const id of created) await request.delete(`${API}/events/${id}`, { headers: auth });
});

test.beforeEach(async ({ context }) => {
  await seedBrowserAuth(context, tokens);
});

test('one performance: it is chosen for you, and Add works straight away', async ({
  page,
  request,
}) => {
  const { eventId, sessionIds } = await draftEvent(
    request,
    `Tickets tab one night ${Date.now()}`,
    'Music',
    1,
  );
  await page.goto(`${ORGANIZER}/organizer/events/${eventId}/tickets`);

  const form = page.getByRole('form', { name: 'Add ticket type' });
  // Named, not asked: there is nothing to pick.
  await expect(form.getByTestId('tt-only-session')).toContainText('Performance 1');
  await expect(form.getByRole('combobox')).toHaveCount(0);
  await expect(form.getByText(/first\. Each ticket type/)).toHaveCount(0);

  await form.getByLabel('Name').fill('Front row');
  await form.getByLabel(/^Price \([A-Z]{3}/).fill('499');
  await form.getByLabel('Quantity on sale').fill('40');
  const add = form.getByRole('button', { name: 'Add ticket type' });
  await expect(add).toBeEnabled();
  await add.click();

  await expect(page.getByText('Ticket type added.')).toBeVisible();
  await expect(page.getByTestId('tt-session-card').getByText('Front row')).toBeVisible();

  // Exactly what the page always sent: price in minor units, the default max of 6.
  const bySession = await ticketTypesBySession(request, eventId);
  expect(bySession[sessionIds[0]]).toHaveLength(1);
  expect(bySession[sessionIds[0]][0]).toMatchObject({
    name: 'Front row',
    priceMinor: 49_900,
    quantityTotal: 40,
    maxPerOrder: 6,
  });
});

test('several matches: the reason is shown, Add points at the picker, and the chosen match gets the ticket type', async ({
  page,
  request,
}) => {
  const { eventId, sessionIds } = await draftEvent(
    request,
    `Tickets tab derby series ${Date.now()}`,
    'Sports',
    3,
  );
  await page.goto(`${ORGANIZER}/organizer/events/${eventId}/tickets`);

  const form = page.getByRole('form', { name: 'Add ticket type' });
  const picker = form.getByRole('combobox', { name: 'Match' });
  await expect(picker).toHaveValue('');
  // Said before anyone presses anything, in the event's own word.
  await expect(
    form.getByText(
      'Select a match first. Each ticket type is sold for one match, and this event has 3.',
    ),
  ).toBeVisible();

  await form.getByLabel('Name').fill('Stand A');
  await form.getByLabel(/^Price \([A-Z]{3}/).fill('250');
  await form.getByLabel('Quantity on sale').fill('80');

  // Not a dead button: pressing it says what is missing and goes there.
  const add = form.getByRole('button', { name: 'Add ticket type' });
  await expect(add).toBeEnabled();
  await add.click();
  await expect(form.getByText('Select a match.', { exact: true })).toBeVisible();
  await expect(picker).toBeFocused();
  expect(Object.values(await ticketTypesBySession(request, eventId)).flat()).toHaveLength(0);

  // The note's own button also goes to the picker.
  await form.getByLabel('Name').focus();
  await form.getByRole('button', { name: 'Select a match' }).click();
  await expect(picker).toBeFocused();

  await picker.selectOption({ index: 2 }); // Match 2
  await expect(form.getByText(/^Select a match first/)).toHaveCount(0);
  await add.click();
  await expect(page.getByText('Ticket type added.')).toBeVisible();

  let bySession = await ticketTypesBySession(request, eventId);
  expect(bySession[sessionIds[0]]).toHaveLength(0);
  expect(bySession[sessionIds[1]]).toHaveLength(1);
  expect(bySession[sessionIds[1]][0]).toMatchObject({
    name: 'Stand A',
    priceMinor: 25_000,
    quantityTotal: 80,
  });

  // A match's own button chooses that match and goes to the name.
  await page.getByRole('button', { name: 'Add ticket type for match 3' }).click();
  await expect(picker).toHaveValue(sessionIds[2]);
  await expect(form.getByLabel('Name')).toBeFocused();
  await form.getByLabel('Name').fill('Stand B');
  await form.getByLabel(/^Price \([A-Z]{3}/).fill('300');
  await form.getByLabel('Quantity on sale').fill('3');
  // Max per order (6) above the quantity: the wizard's rule, said under the field.
  await add.click();
  await expect(
    form.getByText('Max per order cannot be more than the quantity on sale.'),
  ).toBeVisible();
  await form.getByLabel('Max per order').fill('2');
  await add.click();
  await expect(page.getByText('Ticket type added.').first()).toBeVisible();

  await expect
    .poll(async () => (await ticketTypesBySession(request, eventId))[sessionIds[2]].length)
    .toBe(1);
  bySession = await ticketTypesBySession(request, eventId);
  expect(bySession[sessionIds[2]][0]).toMatchObject({ name: 'Stand B', maxPerOrder: 2 });
});
