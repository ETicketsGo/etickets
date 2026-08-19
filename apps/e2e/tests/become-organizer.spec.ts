import { test, expect, type Page } from '@playwright/test';
import { API, CUSTOMER, ORGANIZER } from './helpers';

/**
 * Becoming an organizer, from a standing start.
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────────────
 * This journey used to be a closed loop, and every individual step looked correct:
 *
 *   1. every account is created with the CUSTOMER role
 *   2. the ORGANIZER_OWNER role is granted by creating an organization
 *   3. the page that creates one lives inside /organizer
 *   4. /organizer requires an organizer role
 *
 * So "Start selling tickets" registered an account, redirected to the organizer app across
 * an origin boundary the session could not cross, and the login screen there refused it
 * with "This account cannot access this console" — clearing the session for good measure.
 * The console's own empty state told people to "create one via the API".
 *
 * No unit test could have caught that: each piece was doing its job. Only walking it does.
 */
const PASSWORD = 'Password123!';

const disposable = (tag: string) => ({
  email: `becomeorg_${tag}_${Date.now()}_${Math.floor(Math.random() * 1000)}@e2e.test`,
  fullName: 'Asha Menon',
  password: PASSWORD,
});

/** Register through the real API and seed the CUSTOMER origin's session. */
async function registerAndSignIn(page: Page, who: ReturnType<typeof disposable>) {
  const res = await page.request.post(`${API}/auth/register`, { data: who });
  expect(res.status()).toBe(201);
  const tokens = (await res.json()) as { accessToken: string; refreshToken: string };
  await page.addInitScript((t) => {
    localStorage.setItem('etg_access', t.accessToken);
    localStorage.setItem('etg_refresh', t.refreshToken);
  }, tokens);
  return tokens;
}

test.describe('become an organizer', () => {
  test('1-3: the header shows who you are, not just a way out', async ({ page }) => {
    const who = disposable('hdr');
    await registerAndSignIn(page, who);
    await page.goto(`${CUSTOMER}/`);

    const trigger = page.getByTestId('account-menu-trigger');
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    // The identity is on the button itself, so it is readable without opening anything.
    await expect(trigger).toContainText(who.fullName);

    await trigger.click();
    const menu = page.getByTestId('account-menu');
    await expect(menu).toBeVisible();
    // Which account, specifically — the question a shared device makes urgent.
    await expect(menu).toContainText(who.email);
    await expect(menu.getByRole('menuitem', { name: /Profile/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Sign out/ })).toBeVisible();
  });

  test('4: Escape closes the menu and returns focus to the trigger', async ({ page }) => {
    await registerAndSignIn(page, disposable('esc'));
    await page.goto(`${CUSTOMER}/`);
    const trigger = page.getByTestId('account-menu-trigger');
    await trigger.click();
    await expect(page.getByTestId('account-menu')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-menu')).toBeHidden();
    // Not dropped at the top of the document — the keyboard user carries on from here.
    await expect(trigger).toBeFocused();
  });

  test('5-7: a customer can become an organizer and the role actually arrives', async ({
    page,
  }) => {
    const who = disposable('flow');
    const tokens = await registerAndSignIn(page, who);

    // The account starts as a plain customer. This is the state the old flow could not
    // escape from.
    const before = await (
      await page.request.get(`${API}/auth/me`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
    ).json();
    expect(before.roles).toEqual(['CUSTOMER']);

    await page.goto(`${CUSTOMER}/`);
    await page.getByTestId('account-menu-trigger').click();
    await page.getByTestId('become-organizer').click();

    await expect(page).toHaveURL(/\/account\/become-organizer/);
    await page.getByLabel('Organization name').fill(`Asha Cinemas ${Date.now()}`);
    await page.getByRole('button', { name: 'Create my organization' }).click();

    await expect(page.getByTestId('open-organizer-console')).toBeVisible({ timeout: 20_000 });

    /*
      The role must be on the SESSION, not merely in the database. Creating the organization
      grants ORGANIZER_OWNER server-side, but the browser is still holding a token that
      describes a customer — and the organizer console reads the token. Without the refresh
      this page performs, the operator is bounced straight back out of the console they were
      just told to open.
    */
    const access = await page.evaluate(() => localStorage.getItem('etg_access'));
    expect(access).not.toBe(tokens.accessToken);
    const after = await (
      await page.request.get(`${API}/auth/me`, { headers: { Authorization: `Bearer ${access}` } })
    ).json();
    expect(after.roles).toContain('ORGANIZER_OWNER');
  });

  test('8-9: the organizer console admits them, and its link carries the email', async ({
    page,
  }) => {
    const who = disposable('console');
    await registerAndSignIn(page, who);
    await page.goto(`${CUSTOMER}/account/become-organizer`);
    await page.getByLabel('Organization name').fill(`Menon Screens ${Date.now()}`);
    await page.getByRole('button', { name: 'Create my organization' }).click();

    const link = page.getByTestId('open-organizer-console');
    await expect(link).toBeVisible({ timeout: 20_000 });
    // Prefilled, because the organizer console is a separate origin and therefore a
    // separate sign-in. Making them retype it is how a correct flow still feels broken.
    await expect(link).toHaveAttribute('href', new RegExp(encodeURIComponent(who.email)));

    // Sign in on the organizer origin — the step that used to refuse this account outright.
    await page.goto(`${ORGANIZER}/login`);
    await page.getByLabel('Email').fill(who.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/organizer/, { timeout: 30_000 });
    await expect(page.getByText('This account cannot access this console')).toBeHidden();
  });

  test('10-11: signing in without an organization lands on setup, not a refusal', async ({
    page,
  }) => {
    // A customer who goes straight to the organizer console. Previously: refused, session
    // cleared, and no route forward anywhere in the product.
    const who = disposable('nodrop');
    await page.request.post(`${API}/auth/register`, { data: who });

    await page.goto(`${ORGANIZER}/login`);
    await page.getByLabel('Email').fill(who.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/start/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Set up your organization' })).toBeVisible();

    // And the session survived. Clearing it was what made the dead end permanent.
    const access = await page.evaluate(() => localStorage.getItem('etg_access'));
    expect(access).toBeTruthy();
  });

  test('12: the setup page creates the organization and opens the console', async ({ page }) => {
    const who = disposable('start');
    await registerAndSignIn(page, who);

    await page.goto(`${ORGANIZER}/start`);
    await expect(page.getByRole('heading', { name: 'Set up your organization' })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByLabel('Organization name').fill(`Start Co ${Date.now()}`);
    await page.getByRole('button', { name: 'Create organization' }).click();

    await expect(page).toHaveURL(/\/organizer/, { timeout: 30_000 });
    // Straight into the real console, not back to a guard.
    await expect(page.getByText('Access denied')).toBeHidden();
  });

  test('13: the organizer app still refuses anonymous visitors', async ({ page }) => {
    // The fix must not have opened the door. No session at all still goes to sign-in.
    await page.goto(`${ORGANIZER}/organizer`);
    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  });

  test('14: a signed-out visitor cannot reach the setup page either', async ({ page }) => {
    await page.goto(`${ORGANIZER}/start`);
    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  });
});
