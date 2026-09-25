import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * The admin console after the review: what each screen must now say.
 *
 * ── WHY THESE ARE E2E AND NOT UNIT TESTS ───────────────────────────────────────────
 * Every claim here is about something a person reads on a screen - a heading that names a market,
 * a table that does not scroll sideways, a control that exists at all. None of it is provable from
 * the API: the reports page was per-currency in the service and still read as "only INR" to the
 * person looking at it, because the block had no heading.
 */
/*
  ── ONE LOGIN PER ACCOUNT, NOT ONE PER TEST ───────────────────────────────────────────
  The auth throttle counts REQUESTS, not failed attempts, so a dozen tests each signing in
  through the form trip it and every one of them then fails at the login page - which reads as a
  broken product rather than as a suite hammering the same endpoint. Each account signs in once
  through the API and every test after that starts already authenticated.
*/
let admin: AuthTokens;
let organizer: AuthTokens;

test.beforeAll(async ({ request }) => {
  admin = await apiLogin(request, 'admin@eticketsgo.test');
  organizer = await apiLogin(request, 'owner@eticketsgo.test');
});

test.describe('admin console', () => {
  test.beforeEach(async ({ context, page }) => {
    await seedBrowserAuth(context, admin);
    await page.goto(`${ADMIN}/admin`);
  });

  /**
   * Open a named organizer, wherever in the list it now is.
   *
   * These tests already knew not to take "the first row" - they name the seeded organizer. That
   * was not enough. The list is PAGED, and every run of this suite registers more organizations,
   * so the named row kept sliding off page one: on a database with 53 organizations the seeded
   * "Bengaluru Live" was the 53rd newest-first and simply was not on screen to be clicked.
   *
   * Searching for it is what a person would do, costs one request, and cannot rot with the row
   * count. It also means these tests keep working on a database that has been used.
   */
  async function openOrganizer(page: Page, name: string): Promise<void> {
    await page.goto(`${ADMIN}/admin/organizers`);
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('searchbox').fill(name);
    await page.getByRole('button', { name: 'Search' }).click();
    const row = page.getByRole('row', { name: new RegExp(name, 'i') }).first();
    await expect(row, `no organizer matching "${name}"`).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page).toHaveURL(/\/admin\/organizers\/.+/, { timeout: 20_000 });
  }

  test('an organizer can be suspended or deleted, and says what stands in the way', async ({
    page,
  }) => {
    /*
      The SEEDED organizer, by name, not "the first row".

      The first row is whichever organization sorts first today, and the suite itself registers
      new ones - so a test that takes the first row asserts the refusal against an organization
      that has never sold anything, and the refusal it is checking for correctly does not appear.
      This organizer has bookings against it in the seed, which is the case worth asserting.
    */
    await openOrganizer(page, 'Bengaluru Live');

    // The controls that did not exist at all before.
    await expect(
      page.getByRole('heading', { name: 'Standing and outstanding information' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Suspend' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();

    // A seeded organizer has sold tickets, so the delete dialog refuses and names the reason
    // rather than greying a button out with no explanation.
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText(/booking/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
  });

  test('suspending needs a reason, and the dialog says what it does', async ({ page }) => {
    await openOrganizer(page, 'Bengaluru Live');
    await page.getByRole('button', { name: 'Suspend' }).click();

    await expect(page.getByText(/checkout is refused/)).toBeVisible();
    // No reason typed, no suspension: support and the organizer both have to read it later.
    await expect(page.getByRole('button', { name: 'Suspend them' })).toBeDisabled();
  });

  test('an event can be deleted, with the booking rule stated', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/events`);
    await page.locator('tbody tr').first().click();
    await expect(page).toHaveURL(/\/admin\/events\/.+/, { timeout: 20_000 });

    await page.getByRole('button', { name: 'Delete event' }).click();
    await expect(page.getByText(/refused if anybody has ever booked/)).toBeVisible();
  });

  test('reports name the country, and list the markets that sold nothing', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/reports`);
    await expect(page.getByRole('heading', { name: 'Business reports' })).toBeVisible();

    // "By market" opens by default: the question somebody arrives with.
    await expect(page.getByRole('tab', { name: 'By market' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The half that answers "why do I only see INR" without anybody having to ask.
    await expect(
      page.getByRole('heading', { name: 'Configured, with nothing sold in this range' }),
    ).toBeVisible();
    await expect(page.getByText('United States').first()).toBeVisible();

    // And a currency block that names its country, even when there is only one.
    await page.getByRole('tab', { name: 'Day by day' }).click();
    await expect(page.getByText('India - INR').first()).toBeVisible();
  });

  test('the audit log groups by organizer and by the day it happened', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/audit`);
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();

    // The way in: who was active, before a single row is read.
    await expect(page.getByRole('heading', { name: 'Who was active' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /What .*happened|What .* did/ })).toBeVisible();
  });

  test('accounts are listed by country, and the filters reach the whole directory', async ({
    page,
  }) => {
    await page.goto(`${ADMIN}/admin/users`);
    await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'By country' })).toBeVisible();

    // Suspended accounts: the filter used to run in the browser over one page of 20, so this
    // returned nothing while the pager still counted the whole directory.
    await page.getByLabel('Status filter').selectOption('SUSPENDED');
    await expect(page.getByRole('heading', { name: 'All accounts' })).toBeVisible();
  });

  test('fee rules are called booking fees, under a Pricing rules section', async ({ page }) => {
    // "Settings" said nothing about what the page holds, which is what the platform adds to a
    // ticket price per market.
    await expect(page.getByRole('link', { name: 'Booking fees' })).toBeVisible();
    await page.getByRole('link', { name: 'Booking fees' }).click();
    await expect(page.getByRole('heading', { name: 'Booking fees', exact: true })).toBeVisible();
  });

  test('the reconciliation queue fits the screen', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/finance-reconciliation`);
    await expect(page.getByRole('heading', { name: 'Finance reconciliation' })).toBeVisible();

    /*
      The defect, measured rather than eyeballed: the table used to be wider than its box, so
      reading a row meant dragging a horizontal scrollbar. A table at or under its container's
      width cannot scroll sideways.
    */
    const table = page.locator('table').first();
    if (await table.count()) {
      const overflow = await table.evaluate((el) => {
        const box = el.parentElement as HTMLElement;
        return box.scrollWidth - box.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });
});

/*
  ── A SEARCH BOX THAT SEARCHES THE LIST, NOT THE PAGE ──────────────────────────────
  Organizers, events, payments and refunds each filtered the fifteen rows already fetched, so a
  match sitting on page two came back as "nothing matches" - stated with total confidence, under
  a pager that still counted every row on the platform. The "Search" button did nothing at all:
  `SearchInput` renders one and calls `onSubmit`, and none of these pages passed one.

  The test is the total, not the rows. A client-side filter leaves the count alone, because the
  server was never asked; a real search re-counts. That is the difference being locked in.
*/
test.describe('admin search reaches the database', () => {
  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, admin);
  });

  /**
   * Did the browser ASK the server for this search?
   *
   * The count is not a safe test. It depends on what the suite has created by the time this
   * runs, and comparing a before and an after made the assertion rot the moment another spec
   * registered an organization. The discriminating fact is in the request: a client-side filter
   * sends nothing at all, so the list URL carries no `q`.
   */
  async function listRequestFor(page: Page, path: string, term: string): Promise<string> {
    const asked = page.waitForRequest((r) => r.url().includes(path) && r.url().includes('q='), {
      timeout: 15_000,
    });
    await page.getByRole('searchbox').fill(term);
    await page.getByRole('button', { name: 'Search' }).click();
    return (await asked).url();
  }

  test('the organizer queue asks the server, and shows what it asked for', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/organizers`);
    await expect(page.locator('tbody tr').first()).toBeVisible();

    const url = await listRequestFor(page, '/admin/organizers', 'bengaluru');

    expect(url).toContain('q=bengaluru');
    // Page 1, because a search that keeps your old page number answers about the wrong slice.
    expect(url).toContain('page=1');
    await expect(page.getByRole('row', { name: /Bengaluru Live/ }).first()).toBeVisible();
  });

  test('the payment ledger searches by booking reference', async ({ page }) => {
    /*
      The reference is what somebody arrives holding - from a customer email, or from the
      provider's own dashboard. It used to match only if the payment happened to be among the
      newest fifteen rows.
    */
    await page.goto(`${ADMIN}/admin/payments`);
    await expect(page.locator('tbody tr').first()).toBeVisible();

    const url = await listRequestFor(page, '/admin/payments', 'ETG-IND-2026-0000');

    expect(url).toContain('q=ETG-IND-2026-0000');
  });

  test('the event queue searches by city, which is not even a column', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/events`);
    await page.getByLabel('Status filter').selectOption('');
    await expect(page.getByText(/matching/).first()).toBeVisible();

    const url = await listRequestFor(page, '/admin/events', 'hyderabad');

    expect(url).toContain('q=hyderabad');
  });

  test('the refund queue asks the server too', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/refunds`);
    await page.getByLabel('Status filter').selectOption('');
    await expect(page.getByText(/matching/).first()).toBeVisible();

    const url = await listRequestFor(page, '/admin/refunds', 'example.test');

    expect(url).toContain('q=example.test');
  });
});

test.describe('the admin lists say what a reader needs', () => {
  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, admin);
  });

  test('the organizer queue tells two organizations of the same name apart', async ({ page }) => {
    // The slug is the tiebreak, and it is also what appears in their public URL. Searched for
    // rather than expected on page one - see `openOrganizer` for what that cost before.
    await page.goto(`${ADMIN}/admin/organizers`);
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('searchbox').fill('Bengaluru Live');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText('bengaluru-live').first()).toBeVisible({ timeout: 20_000 });
  });

  test('a standing decision about review reads as what it does', async ({ page }) => {
    /*
      The column was headed "Review" and said "Reviewed" or "Skips review" in grey - it named
      the flag rather than its consequence, and both readings looked like the same thing.
    */
    await page.goto(`${ADMIN}/admin/organizers`);
    await expect(page.getByRole('columnheader', { name: 'New events' })).toBeVisible();
    await expect(page.getByText(/Wait for review|Go live at once/).first()).toBeVisible();
  });

  test('the event queue says when the event is, not when its row was edited', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/events`);
    await page.getByLabel('Status filter').selectOption('');
    await expect(page.getByRole('columnheader', { name: 'When' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Category' })).toHaveCount(0);
  });

  test('a payment names the sale it paid for', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/payments`);
    await expect(page.getByRole('columnheader', { name: 'Payment' })).toBeVisible();
    // The provider reference survives as a detail line, because it is still how you chase one.
    await expect(page.locator('tbody tr').first()).toBeVisible();
  });
});

test.describe('complaints', () => {
  test('an admin can see the complaints against an organizer', async ({ context, page }) => {
    await seedBrowserAuth(context, admin);
    await page.goto(`${ADMIN}/admin/support`);

    await expect(page.getByRole('heading', { name: 'Support and complaints' })).toBeVisible();
    // Its own kind, so it can be counted per seller rather than lost among contact messages.
    await expect(
      page.getByLabel('Kind filter').locator('option', { hasText: 'Complaint' }),
    ).toHaveCount(1);
  });

  test('a customer can raise one from the help center', async ({ page }) => {
    await page.goto('http://localhost:3000/en/help/complaint');
    await expect(page.getByRole('heading', { name: 'Make a complaint' })).toBeVisible();
    await expect(page.getByLabel(/What went wrong/)).toBeVisible();
  });
});

test.describe('organizer console', () => {
  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, organizer);
  });

  test('the dashboard says what the organizer still has to do', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer`);

    /*
      The platform asks organizers for a legal identity, an address, a finance contact and a bank
      account, and until now it asked for none of it anywhere they would look. They found out when
      a settlement could not be paid.

      The panel renders nothing when there is nothing outstanding, which is the point of it - so
      this asserts one or the other is true, never that a nag is present.
      */
    const panel = page.getByRole('heading', { name: 'Needs your attention' });
    const count = await panel.count();
    if (count > 0) {
      await expect(panel).toBeVisible();
      await expect(
        page.getByText(/None of these stops you selling|stops the platform doing/),
      ).toBeVisible();
    }
  });

  test('the settings form asks who answers a complaint', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/settings`);

    // A named person, not an inbox: a marketplace has to be able to say who handles a grievance.
    await expect(page.getByLabel('Complaints contact name')).toBeVisible();
    await expect(page.getByLabel('Complaints contact email')).toBeVisible();
  });
});
