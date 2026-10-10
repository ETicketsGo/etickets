import { test, expect } from '@playwright/test';
import { ADMIN, API, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * The admin command center: the dashboard's attention links, the regrouped menu, and the calendar.
 *
 * Every claim here is about what an operator can reach and read, which is why these are browser
 * tests: the API was already right about every count and every session before this change, and
 * the defect was that a person could not get to it.
 */

let admin: AuthTokens;

test.beforeAll(async ({ request }) => {
  // One sign-in for the file: the auth throttle counts requests, not people.
  admin = await apiLogin(request, 'admin@eticketsgo.test');
});

test.beforeEach(async ({ context }) => {
  await seedBrowserAuth(context, admin);
});

/** Where each attention link must land: the list it counted, already filtered. */
const EXPECTED_HREF: Record<string, RegExp> = {
  disputes: /\/admin\/disputes$/,
  'refunds-requested': /\/admin\/refunds\?status=REQUESTED$/,
  'refunds-failed': /\/admin\/refunds\?status=FAILED$/,
  'payouts-failed': /\/admin\/payouts$/,
  'settlements-blocked': /\/admin\/settlements\?status=BLOCKED$/,
  'reconciliation-open': /\/admin\/finance-reconciliation\?status=OPEN$/,
  'organizers-pending': /\/admin\/organizers\?status=PENDING$/,
  'events-review': /\/admin\/events\?status=UNDER_REVIEW$/,
  'complaints-open': /\/admin\/support\?kind=COMPLAINT&status=OPEN$/,
  'payments-failed-7d':
    /\/admin\/payments\?status=FAILED&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/,
};

test.describe('dashboard: what needs attention', () => {
  test('every queue is shown, each linking to its own filtered list', async ({ page }) => {
    await page.goto(`${ADMIN}/admin`);
    await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();

    // Wait until every queue has answered: it is either a tile, a "clear" chip, or info.
    const links = page.locator('[data-queue]');
    await expect
      .poll(async () => links.count(), { timeout: 30_000 })
      .toBe(Object.keys(EXPECTED_HREF).length);

    const seen: string[] = [];
    for (const link of await links.all()) {
      const key = (await link.getAttribute('data-queue')) as string;
      const href = (await link.getAttribute('href')) as string;
      expect(EXPECTED_HREF[key], `unexpected queue "${key}"`).toBeDefined();
      expect(href, `"${key}" links to the wrong place`).toMatch(EXPECTED_HREF[key]);
      seen.push(key);
    }
    expect(new Set(seen).size).toBe(seen.length);

    // Failed payments are information, kept apart from the work and never counted as it.
    const info = page.getByRole('heading', { name: 'For information' });
    await expect(info).toBeVisible();
    await expect(page.getByText('No action needed')).toBeVisible();
  });

  test('a link lands on the list with its filter already applied', async ({ page }) => {
    await page.goto(`${ADMIN}/admin`);
    const events = page.locator('[data-queue="events-review"]');
    await expect(events).toBeVisible({ timeout: 30_000 });
    await events.click();
    await expect(page).toHaveURL(/\/admin\/events\?status=UNDER_REVIEW/);
    await expect(page.getByLabel('Status filter')).toHaveValue('UNDER_REVIEW');

    await page.goto(`${ADMIN}/admin`);
    const recon = page.locator('[data-queue="reconciliation-open"]');
    await expect(recon).toBeVisible({ timeout: 30_000 });
    await recon.click();
    await expect(page).toHaveURL(/\/admin\/finance-reconciliation\?status=OPEN/);
    await expect(page.getByLabel('Status filter')).toHaveValue('OPEN');
  });
});

test.describe('the regrouped menu', () => {
  test('groups by job, marks exactly one page as current, and opens only its group', async ({
    page,
  }) => {
    await page.goto(`${ADMIN}/admin/refunds`);
    const menu = page.getByRole('navigation', { name: 'Admin' });
    for (const group of [
      'Overview',
      'Events',
      'Organizers & verification',
      'Bookings & payments',
      'Refunds & disputes',
      'Payouts & reconciliation',
      'Operational alerts',
      'Audit history',
      'Platform configuration',
    ]) {
      await expect(menu.getByRole('button', { name: group })).toBeVisible();
    }
    await expect(menu.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(menu.locator('[aria-current="page"]')).toHaveText('Refunds');

    /*
      Only the group holding the current page starts open (the shared console shell): nine
      open groups were the sidebar's own long scroll bar. A folded group opens on a click.
    */
    const refunds = menu.getByRole('button', { name: 'Refunds & disputes' });
    await expect(refunds).toHaveAttribute('aria-expanded', 'true');
    const config = menu.getByRole('button', { name: 'Platform configuration' });
    await expect(config).toHaveAttribute('aria-expanded', 'false');
    await expect(menu.getByRole('link', { name: 'Booking fees' })).toBeHidden();
    await config.click();
    await expect(config).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('link', { name: 'Booking fees' })).toBeVisible();
  });

  test('on a phone the menu is a drawer that Escape closes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${ADMIN}/admin`);
    const toggle = page.getByRole('button', { name: 'Toggle navigation' });
    await toggle.click();
    const drawer = page.getByRole('dialog', { name: 'Admin menu' });
    await expect(drawer).toBeVisible();
    // The drawer is the same tree: Events is folded on the dashboard and opens on a press.
    await drawer.getByRole('button', { name: 'Events', exact: true }).click();
    await expect(drawer.getByRole('link', { name: 'Calendar' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();
  });
});

test.describe('the calendar', () => {
  /** Today as a day, in the zone the browser runs in (the config pins Asia/Kolkata). */
  function todayInBrowserZone(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  }
  function addDays(day: string, n: number): string {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  test("places each show on its venue's day and previews it", async ({ page, request }) => {
    const today = todayInBrowserZone();
    const res = await request.get(
      `${API}/admin/events/calendar?from=${addDays(today, -1)}&to=${addDays(today, 14)}`,
      { headers: { authorization: `Bearer ${admin.accessToken}` } },
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; startsAt: string; timezone: string | null; event: { id: string } }[];
    };

    await page.goto(`${ADMIN}/admin/calendar?view=agenda&date=${today}`);
    await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();

    const inRange = body.data.filter((s) => {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone ?? 'UTC' }).format(
        new Date(s.startsAt),
      );
      return day >= today && day <= addDays(today, 13);
    });
    test.skip(inRange.length === 0, 'no session in the next two weeks in this environment');

    const first = inRange[0];
    const chip = page.locator(`[data-session-id="${first.id}"]`);
    await expect(chip).toBeVisible({ timeout: 30_000 });

    // The heading of the day the chip is listed under is the VENUE's day.
    const venueDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: first.timezone ?? 'UTC',
    }).format(new Date(first.startsAt));
    const d = new Date(`${venueDay}T12:00:00Z`);
    const expectedHeading = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
    const dayItem = page
      .locator('li', { has: chip })
      .filter({ has: page.locator('h3') })
      .last();
    await expect(dayItem.locator('h3').first()).toContainText(expectedHeading);

    await chip.click();
    const preview = page.getByRole('dialog');
    await expect(preview).toBeVisible();
    const open = preview.getByRole('link', { name: 'Open event' });
    await expect(open).toHaveAttribute('href', `/admin/events/${first.event.id}`);
    await open.click();
    await expect(page).toHaveURL(new RegExp(`/admin/events/${first.event.id}$`));
  });

  test('filters live in the URL and narrow the calendar', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/calendar?view=agenda`);
    await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
    await page.getByLabel('Event status').selectOption('PUBLISHED');
    await expect(page).toHaveURL(/status=PUBLISHED/);
    // A non-published event names its status on the chip; none may remain.
    await expect(page.getByText(/ - (Draft|Under review|Cancelled)$/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(page).toHaveURL(/view=week/);
    await expect(page.getByRole('button', { name: 'Week', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('refuses an unbounded window', async ({ request }) => {
    const res = await request.get(`${API}/admin/events/calendar?from=2026-01-01&to=2026-12-31`, {
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.status()).toBe(400);
  });
});
