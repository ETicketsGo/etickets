import { test, expect } from '@playwright/test';
import { ORGANIZER, login, futureLocal } from './helpers';

test('organizer logs in and creates + submits an event via the wizard', async ({ page }) => {
  await login(page, ORGANIZER, 'owner@eticketsgo.test');
  await expect(page).toHaveURL(/\/organizer/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  const title = `E2E Event ${Date.now()}`;
  await page.goto(`${ORGANIZER}/organizer/events/new`);

  // Step 1 — basic details
  await page.getByLabel('Event title').fill(title);
  await page.getByLabel('Category').fill('Music');
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 2 — venue (pick the first existing venue)
  await page.getByLabel('Venue').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 3 — sessions
  await page.getByLabel('Starts at').fill(futureLocal(30, 18));
  await page.getByLabel('Ends at').fill(futureLocal(30, 22));
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 4 — ticket types (defaults are prefilled)
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 5 — fee handling
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 6 — review & submit
  await expect(page.getByText(title)).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();

  // Redirected to the event overview, now under review
  await expect(page).toHaveURL(/\/organizer\/events\/.+/, { timeout: 20_000 });
  await expect(page.getByText('Under Review').first()).toBeVisible({ timeout: 20_000 });

  // It shows up in the events list
  await page.goto(`${ORGANIZER}/organizer/events`);
  await expect(page.getByText(title)).toBeVisible();
});
