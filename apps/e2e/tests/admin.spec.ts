import { test, expect } from '@playwright/test';
import { ADMIN, login } from './helpers';

test('admin reviews an event, then inspects refunds and audit', async ({ page }) => {
  await login(page, ADMIN);
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

  // Audit log has entries
  await page.goto(`${ADMIN}/admin/audit`);
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 20_000 });
});
