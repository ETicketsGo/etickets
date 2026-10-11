import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * The organizer month's "+N more": a busy day folds into a button that selects the day, and the
 * day panel lists every session with a link to where it is managed.
 *
 * ISOLATION: the spec makes its own draft event, with FIVE sessions on one far-future day in a
 * category nobody else uses, and deletes it afterwards (the same pattern as organizer-calendar).
 */
type Auth = Record<string, string>;

const DAY = '2031-04-16';
const SESSIONS = 5;

async function makeFixture(request: APIRequestContext, auth: Auth) {
  const orgs = (await (await request.get(`${API}/organizations`, { headers: auth })).json()) as {
    id: string;
  }[];
  const organizationId = orgs[0].id;
  const venues = (await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json()) as { id: string; timezone: string | null }[];
  const venue = venues.find((v) => v.timezone === 'Asia/Kolkata');
  if (!venue) return null;
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const title = `Dense day ${suffix}`;
  const category = `DenseCat${suffix}`;
  const res = await request.post(`${API}/events`, {
    headers: auth,
    data: { organizationId, venueId: venue.id, title, category, feeMode: 'CUSTOMER_PAYS' },
  });
  expect(res.ok()).toBe(true);
  const event = (await res.json()) as { id: string };
  for (let i = 0; i < SESSIONS; i += 1) {
    // 09:00, 11:00, ... IST: 03:30Z + 2h steps.
    const start = new Date(`${DAY}T03:30:00.000Z`).getTime() + i * 2 * 3_600_000;
    const session = await request.post(`${API}/events/${event.id}/sessions`, {
      headers: auth,
      data: {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 3_600_000).toISOString(),
      },
    });
    expect(session.ok()).toBe(true);
  }
  return { id: event.id, title, category };
}

test.describe('calendar +N more', () => {
  test('folds a busy day, opens it from the keyboard, and links to the right page', async ({
    browser,
    request,
  }) => {
    const tokens = await apiLogin(request, 'owner@eticketsgo.test');
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const fixture = await makeFixture(request, auth);
    test.skip(!fixture, 'no seeded venue in Asia/Kolkata');
    const { id, title, category } = fixture!;

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await seedBrowserAuth(context, tokens);
    const page = await context.newPage();
    try {
      await page.goto(`${ORGANIZER}/organizer/calendar?view=month&date=${DAY}&category=${category}`);
      const cell = page.getByTestId(`month-day-${DAY}`);
      // Desktop shows three, and the other two are one button.
      await expect(cell.locator('[data-session-id]')).toHaveCount(3);
      const more = page.getByTestId(`month-more-${DAY}`);
      await expect(more).toHaveText('+2 more');
      await expect(more).toHaveAccessibleName(/2 more sessions on .*Show them in the day panel/);

      // Keyboard: focus the button and press Enter. The day panel takes focus and lists all five.
      await more.focus();
      await page.keyboard.press('Enter');
      const heading = page.locator('#calendar-day-panel');
      await expect(heading).toBeFocused();
      await expect(heading).toHaveText(/16 Apr 2031/);
      const panel = page.getByTestId('calendar-day-panel');
      await expect(panel.locator('[data-session-id]')).toHaveCount(SESSIONS);

      // The row's link goes to the event's sessions page (general admission, not a film).
      const link = panel.getByTestId('calendar-destination').first();
      await expect(link).toHaveText('Manage sessions');
      await expect(link).toHaveAttribute('href', `/organizer/events/${id}/sessions`);

      // A chip opens the quick look, whose primary button is the same destination.
      await cell.locator('[data-session-id]').first().click();
      const drawer = page.getByRole('dialog', { name: title });
      await expect(drawer.getByRole('link', { name: 'Manage sessions' })).toHaveAttribute(
        'href',
        `/organizer/events/${id}/sessions`,
      );
      await drawer.getByRole('link', { name: 'Manage sessions' }).click();
      await expect(page).toHaveURL(new RegExp(`/organizer/events/${id}/sessions$`));
    } finally {
      await context.close();
      await request.delete(`${API}/events/${id}`, { headers: auth });
    }
  });
});
