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

  // Premium event page: reviews + FAQ sections render
  await expect(page.getByText('Ratings & reviews')).toBeVisible();
  await expect(page.getByText('Frequently asked questions')).toBeVisible();

  // Select a ticket quantity — book MULTIPLE tickets in one booking
  const qty = page.locator('select[aria-label^="Quantity"]').first();
  await expect(qty).toBeVisible();
  await qty.selectOption('2');

  await page.getByRole('button', { name: /Continue to payment/ }).click();

  // Fee breakdown then pay (mock)
  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
  await expect(page.getByText('Total payable')).toBeVisible();
  await page.getByRole('button', { name: /Pay/ }).click();

  // Confirmation
  await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });
  await expect(page.getByRole('link', { name: 'View my ticket' })).toBeVisible({ timeout: 20_000 });

  // Ticket wallet: the multi-ticket booking shows as ONE booking group card
  await page.getByRole('link', { name: 'View my ticket' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/);
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByText('2 tickets')).toBeVisible({ timeout: 20_000 });

  // Open the group → focused ticket viewer
  await page.getByRole('link', { name: 'View tickets' }).click();
  await expect(page).toHaveURL(/\/account\/bookings\/.+\/tickets/);
  await expect(page.getByText('Ticket 1 of 2')).toBeVisible({ timeout: 20_000 });

  // Each ticket has its own distinct QR / ticket id
  const firstQrAlt = await page.locator('img[alt^="QR code for ticket"]').getAttribute('alt');

  // Navigate to the next ticket → counter updates, QR changes
  await page.getByRole('button', { name: 'Next ticket' }).click();
  await expect(page.getByText('Ticket 2 of 2')).toBeVisible();
  const secondQrAlt = await page.locator('img[alt^="QR code for ticket"]').getAttribute('alt');
  expect(secondQrAlt).not.toEqual(firstQrAlt);

  // Event Day Mode: full-screen boarding-pass experience
  await page.getByRole('button', { name: 'Event Day Mode', exact: true }).click();
  const eventDay = page.getByRole('dialog');
  await expect(eventDay).toBeVisible();
  await expect(eventDay.locator('img[alt^="QR code for ticket"]')).toBeVisible();
  await expect(eventDay.getByText('2 / 2')).toBeVisible();

  // Navigate inside Event Day Mode, then exit back to the viewer
  await eventDay.getByRole('button', { name: 'Previous ticket' }).click();
  await expect(eventDay.getByText('1 / 2')).toBeVisible();
  await eventDay.getByRole('button', { name: 'Exit event day mode' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The individual ticket detail page still works from the viewer
  await page.getByRole('link', { name: 'Full ticket details' }).click();
  await expect(page).toHaveURL(/\/account\/tickets\/.+/);
  await expect(page.getByRole('button', { name: /All tickets/ })).toBeVisible({ timeout: 20_000 });
});
