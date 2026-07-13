import { test, expect } from '@playwright/test';
import { CUSTOMER, SEED_PASSWORD, uniqueEmail } from './helpers';

test('customer registers, books a ticket, pays, and sees a QR ticket', async ({ page }) => {
  // Register
  await page.goto(`${CUSTOMER}/register`);
  await page.getByLabel('Full name').fill('E2E Customer');
  await page.getByLabel('Email').fill(uniqueEmail('cust'));
  await page.getByLabel(/Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/, { timeout: 20_000 });

  // Browse and open the first event
  await page.goto(`${CUSTOMER}/events`);
  const firstEvent = page.locator('a[href^="/events/"]').first();
  await expect(firstEvent).toBeVisible();
  await firstEvent.click();
  await expect(page).toHaveURL(/\/events\/.+/);

  // Select a ticket quantity
  const qty = page.locator('select[aria-label^="Quantity"]').first();
  await expect(qty).toBeVisible();
  await qty.selectOption('1');

  await page.getByRole('button', { name: /Continue to payment/ }).click();

  // Fee breakdown then pay (mock)
  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
  await expect(page.getByText('Total payable')).toBeVisible();
  await page.getByRole('button', { name: /Pay/ }).click();

  // Confirmation
  await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });
  await expect(page.getByRole('link', { name: 'View my ticket' })).toBeVisible({ timeout: 20_000 });

  // QR ticket wallet
  await page.getByRole('link', { name: 'View my ticket' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/);
  await expect(page.locator('img[alt^="QR code for ticket"]').first()).toBeVisible({
    timeout: 20_000,
  });

  // Open the premium ticket detail
  await page.locator('a[href^="/account/tickets/"]').first().click();
  await expect(page).toHaveURL(/\/account\/tickets\/.+/);
  await expect(page.getByRole('button', { name: /All tickets/ })).toBeVisible({ timeout: 20_000 });
});
