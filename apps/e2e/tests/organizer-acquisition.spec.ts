import { expect, test } from '@playwright/test';
import { ADMIN, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * Organizer Acquisition, walked in the browser by the seeded super admin: open the section,
 * add a prospect, log a call with a follow-up, move it along the pipeline, find it again.
 *
 * Who may see what is proven at the API (crm-boundary.http.integration-postgres.spec.ts) and in
 * the menu tests (apps/admin-web/lib/crm.test.ts); this proves the pages actually work.
 */
test.describe('organizer acquisition', () => {
  let tokens: AuthTokens;
  const name = `E2E Prospect ${Date.now().toString(36)}`;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, 'admin@eticketsgo.test');
  });
  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('add a prospect, log outreach, move it on, find it again', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/acquisition`);
    await expect(page.getByRole('heading', { name: 'Organizer Acquisition' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Where leads are now')).toBeVisible();
    // The menu has the section, under Organizers, open on its own pages, with its pages as tabs.
    const nav = page.getByRole('navigation', { name: 'Admin' });
    await expect(
      nav.getByRole('link', { name: 'Organizer Acquisition', exact: true }),
    ).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Prospects', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add prospect' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a prospect' });
    await expect(dialog).toBeVisible();
    // A super admin sees every team; pick India.
    await dialog.getByLabel('Team').selectOption({ label: 'India (India)' });
    await dialog.getByLabel('Organization name').fill(name);
    await dialog.getByLabel('City').fill('Vijayawada');
    await dialog
      .getByLabel('Business email')
      .fill(`hello@${name.replace(/\W+/g, '-').toLowerCase()}.in`);
    await dialog.getByRole('button', { name: 'Add prospect' }).click();

    await expect(page).toHaveURL(/\/admin\/acquisition\/prospects\/.+/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText('Next action:')).toBeVisible();

    // Log a call; a follow-up is scheduled with it by default.
    const log = page.getByRole('button', { name: 'Log activity' });
    await log.click();
    await expect(page.getByText('Activity logged.')).toBeVisible();
    const history = page.getByRole('list').filter({ hasText: 'Added as Identified' });
    await expect(history.getByRole('listitem').filter({ hasText: 'Phone call' })).toBeVisible();
    await expect(page.getByText(/ETicketsGo did not send/).first()).toBeVisible();
    await expect(page.getByText(/Follow-up in 2 days|due in the next 24 hours/)).toBeVisible();

    // Move it on: only the allowed next stages are offered.
    const moveTo = page.getByLabel('Move to');
    await expect(moveTo.locator('option', { hasText: 'Demo completed' })).toHaveCount(0);
    await moveTo.selectOption({ label: 'Contacted' });
    await page.getByRole('button', { name: 'Move' }).click();
    await expect(page.getByText('Stage changed.')).toBeVisible();
    await expect(page.getByText('Moved from Identified to Contacted')).toBeVisible();

    // And it is in the list, found by the server-side search.
    await page.goto(`${ADMIN}/admin/acquisition/prospects`);
    await page.getByRole('searchbox').fill(name);
    await page.getByRole('searchbox').press('Enter');
    // The table (desktop) and the cards (phone) both render the row; the table is the one shown.
    await expect(page.locator('table').getByText(name)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('1 matching')).toBeVisible();
  });

  test('reports load with stated denominators', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/acquisition/reports`);
    await expect(page.getByRole('heading', { name: 'Acquisition reports' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('heading', { name: 'India and USA' })).toBeVisible();
    await expect(page.getByText(/ of \d+ leads \(\d+%\)/).first()).toBeVisible({ timeout: 20_000 });
  });
});
