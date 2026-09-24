import { test, expect } from '@playwright/test';
import { ADMIN, login } from './helpers';

test('admin reviews an event, then inspects refunds and audit', async ({ page }) => {
  await login(page, ADMIN, 'admin@eticketsgo.test');
  await expect(page).toHaveURL(/\/admin/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Platform overview' })).toBeVisible();

  // Events under review
  await page.goto(`${ADMIN}/admin/events`);
  await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();

  const firstRow = page.locator('tbody tr').first();
  if (await firstRow.count()) {
    await firstRow.click();
    await expect(page).toHaveURL(/\/admin\/events\/.+/, { timeout: 20_000 });
    const approve = page.getByRole('button', { name: 'Approve' });
    if (await approve.count()) {
      await approve.click();
      await expect(page.getByText('Published').first()).toBeVisible({ timeout: 20_000 });
    }
  }

  // Refunds queue loads
  await page.goto(`${ADMIN}/admin/refunds`);
  await expect(page.getByRole('heading', { name: 'Refunds' })).toBeVisible();

  // Audit log has entries.
  //
  // No longer a table: five columns - action, entity, actor, correlation id, time - were what
  // made this page wider than the screen, and the entries now read as lines grouped under the day
  // they happened on. The claim is the same one: there is something in the log.
  await page.goto(`${ADMIN}/admin/audit`);
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(page.getByRole('listitem').first()).toBeVisible({ timeout: 20_000 });
});
