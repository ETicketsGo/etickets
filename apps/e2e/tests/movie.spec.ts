import { test, expect } from '@playwright/test';
import { CUSTOMER, SEED_PASSWORD, uniqueEmail } from './helpers';

test('customer books a movie seat and pays', async ({ page }) => {
  // Register
  await page.goto(`${CUSTOMER}/register`);
  await page.getByLabel('Full name').fill('E2E Movie Fan');
  await page.getByLabel('Email').fill(uniqueEmail('movie'));
  await page.getByLabel(/Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/, { timeout: 20_000 });

  // Movie discovery renders
  await page.goto(`${CUSTOMER}/movies`);
  await expect(page.locator('a[href^="/movies/"]').first()).toBeVisible();

  // Open the seeded bookable movie and pick a showtime
  await page.goto(`${CUSTOMER}/movies/skyfront-protocol`);
  const showtime = page.locator('a[href^="/shows/"]').first();
  await expect(showtime).toBeVisible({ timeout: 20_000 });
  await showtime.click();
  await expect(page).toHaveURL(/\/shows\/.+/);

  // Select the first available seat
  const seat = page.locator('button[aria-label^="Seat"][aria-label*="available" i]').first();
  await expect(seat).toBeVisible({ timeout: 20_000 });
  await seat.click();

  // Proceed to the (shared) payment flow
  await page.getByRole('button', { name: /Proceed to pay/i }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
  await page.getByRole('button', { name: /Pay/ }).click();

  // Confirmation
  await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });
});
