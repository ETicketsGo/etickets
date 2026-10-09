import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * The organizer's event list and an event's overview.
 *
 * Proves the three things the redesign added that a unit test cannot: that the view an
 * organizer picks is still picked after a reload, that the filters narrow the list a person
 * actually sees, and that the overview's sections render for a real event. The event is this
 * spec's own - a long title and a session - and is deleted afterwards; nothing seeded is touched.
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
  // Long on purpose: the card, the table and the header must wrap it, never scroll sideways.
  const title = `List view check ${Date.now()} with a title long enough to wrap onto several lines on a phone`;
  const res = await request.post(`${API}/events`, {
    headers: auth,
    data: {
      organizationId,
      venueId: venues[0].id,
      title,
      category: 'Workshop',
      feeMode: 'CUSTOMER_PAYS',
      description: 'A long description. '.repeat(40),
    },
  });
  expect(res.ok()).toBe(true);
  const event = (await res.json()) as { id: string };
  const start = new Date(Date.now() + 7 * 24 * 3_600_000);
  const session = await request.post(`${API}/events/${event.id}/sessions`, {
    headers: auth,
    data: {
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 2 * 3_600_000).toISOString(),
    },
  });
  expect(session.ok()).toBe(true);
  return { id: event.id, title };
}

test.describe('organizer events list and overview', () => {
  test('the view is remembered, the filters narrow the list, and the overview has its sections', async ({
    browser,
    request,
  }) => {
    const tokens = await apiLogin(request, 'owner@eticketsgo.test');
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const organizationId = await firstOrg(request, auth);
    const event = await makeEvent(request, auth, organizationId);

    const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
    await seedBrowserAuth(context, tokens);
    const page = await context.newPage();
    try {
      await page.goto(`${ORGANIZER}/organizer/events`);
      await page.getByPlaceholder('Search events…').fill(event.title);

      // Cards by default, with the event's schedule and approval state in words.
      const card = page.getByRole('article', { name: event.title });
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card).toContainText('Not submitted');
      await expect(card).toContainText('Next:');

      // The table, chosen once, is still the table after a reload.
      await page.getByRole('button', { name: 'Table' }).click();
      await expect(page.getByRole('button', { name: 'Table' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(page.getByRole('table')).toBeVisible();
      await page.reload();
      await expect(page.getByRole('button', { name: 'Table' })).toHaveAttribute(
        'aria-pressed',
        'true',
        { timeout: 20_000 },
      );
      await expect(page.getByRole('table')).toBeVisible();

      // Filters narrow what is shown.
      await page.getByPlaceholder('Search events…').fill(event.title);
      await page.getByLabel('Status').selectOption('DRAFT');
      await page.getByLabel('Category').selectOption('Workshop');
      await expect(page.locator('tbody tr')).toHaveCount(1);
      await expect(page.locator('tbody tr')).toContainText('List view check');
      await page.getByLabel('Status').selectOption('PUBLISHED');
      await expect(page.getByText('No events match your filters')).toBeVisible();
      await page.getByRole('button', { name: 'Clear filters' }).first().click();

      /*
        On a phone: the filters fold behind one button, the table gives way to cards (the
        choice is kept), and nothing on the page is wider than the screen.
      */
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByPlaceholder('Search events…').fill(event.title);
      await expect(page.getByLabel('Status')).toBeHidden();
      await page.getByRole('button', { name: /^Filters/ }).click();
      await expect(page.getByLabel('Status')).toBeVisible();
      await expect(page.getByRole('article', { name: event.title })).toBeVisible();
      await expect(page.getByText('The table needs a wider screen')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // The overview: header, readable description and its sections.
      await page.goto(`${ORGANIZER}/organizer/events/${event.id}`);
      await expect(page.getByRole('heading', { level: 1, name: event.title })).toBeVisible({
        timeout: 20_000,
      });
      for (const name of ['About this event', 'Tickets & capacity', 'Sales', 'Sessions', 'Go to']) {
        await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      }
      const readMore = page.getByRole('button', { name: 'Read more' });
      await expect(readMore).toHaveAttribute('aria-expanded', 'false');
      await readMore.click();
      await expect(page.getByRole('button', { name: 'Show less' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(page.getByText('1 to come, 0 past.')).toBeVisible();
      const overviewOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overviewOverflow).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
      await request.delete(`${API}/events/${event.id}`, { headers: auth });
    }
  });
});
