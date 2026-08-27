import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type APIRequestContext,
} from '@playwright/test';

/**
 * Post-deploy validation, run against QA itself rather than a local stack.
 *
 * Everything here has already been proven locally and in CI. What this checks is the one
 * thing neither can: that the build which actually reached QA behaves the same way. Two
 * defects in this project's history were only ever visible here — a receipt link that 401'd
 * because it carried no bearer token, and a session time that came back null.
 *
 * Not part of the CI suite: the hostnames are QA's and it depends on QA's seed.
 */
const CUSTOMER = 'https://customer-web-qa.up.railway.app';
const ORGANIZER = 'https://organizer-web-qa.up.railway.app';
const ADMIN = 'https://admin-web-qa.up.railway.app';
const API = 'https://api-qa-f580.up.railway.app/api';
const PW = 'Password123!';

/**
 * Sign in over the API and hand the tokens to the browser.
 *
 * Not through the login form. QA throttles authentication, and a suite that signs in once
 * per test trips it — which is what turned four of these into "login did not navigate"
 * failures that had nothing to do with the thing each was checking.
 */
async function auth(context: BrowserContext, request: APIRequestContext, email: string) {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PW } });
  expect(res.ok(), `login failed for ${email}`).toBe(true);
  const body = await res.json();
  await context.addInitScript((t) => {
    localStorage.setItem('etg_access', t.accessToken);
    localStorage.setItem('etg_refresh', t.refreshToken);
  }, body);
}

/**
 * Wait for React, not just for HTML.
 *
 * `domcontentloaded` returns while the page is still server-rendered markup: every control
 * is visible and none of them does anything yet. Clicking in that window silently has no
 * effect, which reads exactly like a broken button — and did, on the first run of this file.
 */
async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'networkidle' });
}

const cityChip = (page: Page) =>
  page.getByRole('button', { name: /All cities|Mumbai|Bengaluru|Hyd/ }).first();

test.describe('QA: shopping by city', () => {
  test('the header carries a city chip, filled from live inventory', async ({ page }) => {
    // /explore, not /. A signed-out visitor at the root gets the marketing shell, which has
    // its own nav and deliberately no city control.
    await open(page, `${CUSTOMER}/explore`);
    await expect(cityChip(page)).toBeVisible();
    await cityChip(page).click();

    const dialog = page.getByRole('dialog', { name: 'Choose your city' });
    await expect(dialog).toBeVisible();
    // Derived from what is actually on sale, never a hardcoded launch list.
    await expect(dialog.getByRole('button', { name: /^Bengaluru/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'All cities' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Use my location/ })).toBeVisible();
  });

  test('choosing a city sticks across a reload', async ({ page }) => {
    await open(page, `${CUSTOMER}/explore`);
    await cityChip(page).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^Bengaluru/ })
      .click();
    await expect(page.getByRole('button', { name: /Bengaluru/ }).first()).toBeVisible();

    // The choice lives on the device, so it survives a reload rather than being re-guessed.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: /Bengaluru/ }).first()).toBeVisible();
  });

  test('only cities with something on sale are offered', async ({ page }) => {
    await open(page, `${CUSTOMER}/explore`);
    await cityChip(page).click();
    // Pune has no inventory, so it is not in the picker at all — the first half of the
    // promise that a chosen city can never empty the page.
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Pune/ })).toHaveCount(0);
  });
});

test.describe('QA: back-office duties', () => {
  test('the staff screen says why a super admin is not editable', async ({
    page,
    context,
    request,
  }) => {
    await auth(context, request, 'admin@eticketsgo.test');
    await open(page, `${ADMIN}/admin/staff`);

    await expect(page.getByRole('heading', { name: 'Back-office staff' })).toBeVisible();
    // Scoped to the page body: the signed-in admin's own email also sits in the header
    // account menu, so a page-wide query matches twice.
    const row = page.getByRole('main').getByText('admin@eticketsgo.test');
    await expect(row).toBeVisible();
    await expect(page.getByText('Super admin')).toBeVisible();
    // An empty permission list would read as "can do nothing"; the screen says the opposite.
    await expect(page.getByText(/Holds every permission/)).toBeVisible();
  });

  test('adding staff searches existing accounts and warns on the duties that matter', async ({
    page,
    context,
    request,
  }) => {
    await auth(context, request, 'admin@eticketsgo.test');
    await open(page, `${ADMIN}/admin/staff`);
    await page.getByRole('button', { name: 'Add staff' }).click();

    // Said out loud, because "add staff" usually means "create an account" and here it does not.
    await expect(page.getByText(/They need an ETicketsGo account already/)).toBeVisible();
    // The two warnings that stop somebody clicking straight through into granting everything.
    await expect(page.getByText(/Grants everything in practice/)).toBeVisible();
    await expect(page.getByText(/Moves money, and it does not come back/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refund desk' })).toBeVisible();
  });

  test('a new back-office account starts with nothing ticked', async ({
    page,
    context,
    request,
  }) => {
    await auth(context, request, 'admin@eticketsgo.test');
    await open(page, `${ADMIN}/admin/staff`);
    await page.getByRole('button', { name: 'Add staff' }).click();

    /*
      The default that matters most.

      The old behaviour was that every admin could do everything, and a screen that
      pre-ticks a generous preset quietly restores it for anybody who clicks through
      without reading.
    */
    const tickedBefore = await page
      .getByRole('checkbox')
      .evaluateAll((boxes) => boxes.filter((b) => (b as HTMLInputElement).checked).length);
    expect(tickedBefore).toBe(0);

    // A preset is a shortcut to a set of ticks, not a role that gets saved — so editing a
    // preset later can never silently change what somebody already holds.
    await page.getByRole('button', { name: 'Refund desk' }).click();
    const tickedAfter = await page
      .getByRole('checkbox')
      .evaluateAll((boxes) => boxes.filter((b) => (b as HTMLInputElement).checked).length);
    expect(tickedAfter).toBe(3);
  });
});

test.describe('QA: picking a date and a time', () => {
  /** Through the wizard as far as the session step, which is where the field lives. */
  async function toSessionStep(page: Page, title: string) {
    await page.getByLabel('Event title').fill(title);
    // A dropdown now, not a text box: browse builds its category list with `distinct`
    // over this column, so every typo an organizer typed became its own row on the front page.
    await page.getByLabel('Category').selectOption('Music');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByLabel('Venue').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  }

  test('the session field is a date plus a time, and reads itself back', async ({
    page,
    context,
    request,
  }) => {
    await auth(context, request, 'owner@eticketsgo.test');
    await open(page, `${ORGANIZER}/organizer/events/new`);
    await toSessionStep(page, `QA check ${Date.now()}`);

    await expect(page.getByRole('group', { name: 'Starts at' })).toBeVisible();
    await page.locator('#ss0').fill('2027-03-14');
    await page.locator('#ss0-time').selectOption('19:00');

    // The readback is the point: it is what catches a mistyped year before an audience does.
    await expect(
      page
        .getByRole('group', { name: 'Starts at' })
        .getByRole('paragraph')
        .filter({ hasText: 'Sun 14 Mar 2027, 7:00 PM' }),
    ).toBeVisible();

    // The end field asks "how long", not "which date and time all over again".
    await page.getByRole('button', { name: '+2h' }).click();
    await expect(
      page
        .getByRole('group', { name: 'Ends at' })
        .getByRole('paragraph')
        .filter({ hasText: 'Sun 14 Mar 2027, 9:00 PM' }),
    ).toBeVisible();
  });

  test('the day shortcuts do not collide with the wizard own Next button', async ({
    page,
    context,
    request,
  }) => {
    await auth(context, request, 'owner@eticketsgo.test');
    await open(page, `${ORGANIZER}/organizer/events/new`);
    await toSessionStep(page, `QA chips ${Date.now()}`);

    // "In a week", not "Next week" — two adjacent controls starting with the same word is a
    // real misread, and a skim-click would change the date instead of advancing the step.
    await expect(page.getByRole('button', { name: 'In a week' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next week' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(1);
  });
});
