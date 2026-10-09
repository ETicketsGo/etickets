import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * The organizer calendar: opens, switches views, filters, and previews a session with a link
 * to its event.
 *
 * ── ISOLATION ─────────────────────────────────────────────────────────────────────
 * The spec makes its OWN draft event, in a category nobody else uses, on a date years ahead,
 * and deletes it afterwards. The seeded organizer has dozens of sessions; asserting on "the
 * first chip" would test whatever the seed happened to contain that day.
 *
 * The session is placed at 19:00 at a venue in Asia/Kolkata, and the browser here also runs in
 * Asia/Kolkata (playwright.config), so the venue-zone rule itself is proven by the unit tests,
 * not here: this spec is about the route working end to end.
 */
type Auth = Record<string, string>;

const DAY = '2031-03-12';

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
  const title = `Calendar e2e ${suffix}`;
  const category = `CalCat${suffix}`;
  const res = await request.post(`${API}/events`, {
    headers: auth,
    data: { organizationId, venueId: venue.id, title, category, feeMode: 'CUSTOMER_PAYS' },
  });
  expect(res.ok()).toBe(true);
  const event = (await res.json()) as { id: string };
  // 19:00 to 22:00 IST.
  const session = await request.post(`${API}/events/${event.id}/sessions`, {
    headers: auth,
    data: { startsAt: `${DAY}T13:30:00.000Z`, endsAt: `${DAY}T16:30:00.000Z` },
  });
  expect(session.ok()).toBe(true);
  return { id: event.id, title, category };
}

test.describe('organizer calendar', () => {
  test('opens, switches views, filters, and previews a session', async ({ browser, request }) => {
    const tokens = await apiLogin(request, 'owner@eticketsgo.test');
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const fixture = await makeFixture(request, auth);
    test.skip(!fixture, 'no seeded venue in Asia/Kolkata');
    const { id, title, category } = fixture!;

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await seedBrowserAuth(context, tokens);
    const page = await context.newPage();
    try {
      await page.goto(`${ORGANIZER}/organizer/calendar?date=${DAY}&category=${category}`);
      await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
      await expect(page.getByTestId('calendar-range-title')).toHaveText('March 2031');

      // Month: the chip sits on its day, at its venue time.
      const chip = page
        .getByTestId(`month-day-${DAY}`)
        .getByRole('button', { name: new RegExp(`^19:00 .*${title}`) });
      await expect(chip).toBeVisible();

      // Week, day and list each show it.
      await page.getByRole('button', { name: 'Week', exact: true }).click();
      await expect(page.getByTestId('calendar-range-title')).toHaveText('10 Mar - 16 Mar 2031');
      await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();
      await page.getByRole('button', { name: 'Day', exact: true }).click();
      await expect(page.getByTestId('calendar-range-title')).toHaveText('Wed, 12 Mar 2031');
      await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();
      await page.getByRole('button', { name: 'List', exact: true }).click();
      await expect(page.getByTestId(`agenda-day-${DAY}`)).toContainText(title);
      await expect(page.getByTestId(`agenda-day-${DAY}`)).toContainText('19:00 - 22:00');

      // A status the event does not have hides it, and says the filters are why.
      await page.getByLabel('Status').selectOption('PUBLISHED');
      await expect(page.getByText('No sessions in this view match the filters.')).toBeVisible();
      await page.getByRole('button', { name: 'Clear filters' }).click();
      await page.getByLabel('Category').selectOption(category);
      await page.getByLabel('Status').selectOption('DRAFT');
      await expect(page.getByTestId(`agenda-day-${DAY}`)).toContainText(title);

      // Back to the month; the keyboard moves between days and Enter opens the preview.
      await page.getByRole('button', { name: 'Month', exact: true }).click();
      const cell = page.getByTestId(`month-day-${DAY}`);
      await page.getByTestId('month-day-2031-03-11').focus();
      await page.keyboard.press('ArrowRight');
      await expect(cell).toBeFocused();
      await page.keyboard.press('Enter');

      const drawer = page.getByRole('dialog', { name: title });
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText('Wed, 12 Mar 2031, 19:00 - 22:00');
      await expect(drawer).toContainText('Asia/Kolkata');
      await expect(drawer).toContainText('Event: Draft');
      await expect(drawer.getByRole('link', { name: 'Open event' })).toHaveAttribute(
        'href',
        `/organizer/events/${id}`,
      );

      // Escape closes it and hands focus back to where it came from.
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(cell).toBeFocused();

      // A click on the chip opens it too, and the link goes to the event.
      await chip.click();
      await expect(drawer).toBeVisible();
      await drawer.getByRole('link', { name: 'Open event' }).click();
      await expect(page).toHaveURL(new RegExp(`/organizer/events/${id}$`));
    } finally {
      await context.close();
      await request.delete(`${API}/events/${id}`, { headers: auth });
    }
  });
});
