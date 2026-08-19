import { test, expect, type Page } from '@playwright/test';
import { CUSTOMER, SEED_PASSWORD, uniqueEmail } from './helpers';

/** Registers a fresh customer and books `qty` tickets, landing on confirmation. */
async function registerAndBook(page: Page, name: string, email: string, qty: string) {
  await page.goto(`${CUSTOMER}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/, { timeout: 20_000 });

  await page.goto(`${CUSTOMER}/events`);
  await page.locator('a[href^="/events/"]').first().click();
  await page.locator('select[aria-label^="Quantity"]').first().selectOption(qty);
  await page.getByRole('button', { name: /Continue to payment/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
  await page.getByRole('button', { name: /Pay/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });
}

test('offline wallet: a cached pass stays accessible without connectivity', async ({
  page,
  context,
}) => {
  await registerAndBook(page, 'Offline User', uniqueEmail('offline'), '2');
  await page.getByRole('link', { name: 'View my ticket' }).click();
  await expect(page).toHaveURL(/\/account\/tickets$/);
  await expect(page.getByRole('heading', { name: 'My experiences' })).toBeVisible({
    timeout: 20_000,
  });

  // Wait for the service worker to control the page, then reload once online so the
  // wallet route's shell is cached under SW control.
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, {
    timeout: 20_000,
  });
  await page.reload();
  // The online wallet must show (and therefore cache) the booked tickets before
  // we go offline.
  await expect(page.getByText('2 tickets')).toBeVisible({ timeout: 20_000 });

  // ── The wallet reopens offline from the cached pass ──
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My experiences' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('2 tickets')).toBeVisible();
  await expect(page.getByText(/Offline/)).toBeVisible();
  await context.setOffline(false);

  // Open the ticket viewer online and cache its shell (reload = full navigation).
  await page.getByRole('link', { name: 'View tickets' }).click();
  await expect(page).toHaveURL(/\/account\/bookings\/.+\/tickets$/);
  await expect(page.getByText('Ticket 1 of 2')).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(page.getByText('Ticket 1 of 2')).toBeVisible({ timeout: 20_000 });

  // ── The pass (QR + group nav) reopens offline ──
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Ticket 1 of 2')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('img[alt^="QR code for ticket"]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Next ticket' }).click();
  await expect(page.getByText('Ticket 2 of 2')).toBeVisible();

  // Event Day Mode offline: shows the pass but defers authority to the scanner
  await page.getByRole('button', { name: 'Event Day Mode', exact: true }).click();
  await expect(page.getByText(/confirmed by the scanner/i)).toBeVisible();
  await page.getByRole('button', { name: 'Exit event day mode' }).click();

  // ── Reconnect → resynchronize ──
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByText('Ticket 1 of 2')).toBeVisible({ timeout: 20_000 });
});

test('offline privacy: logout clears cache and a second user cannot see it', async ({ page }) => {
  // User A books + loads their wallet (caches it)
  await registerAndBook(page, 'User A', uniqueEmail('userA'), '1');
  await page.getByRole('link', { name: 'View my ticket' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/);
  await expect(page.getByRole('link', { name: /View ticket/ })).toBeVisible({ timeout: 20_000 });

  // A signs out (purges their cached wallet). Sign out now lives inside the account menu,
  // which is where it belongs — the header shows WHO is signed in, so a shared device shows
  // the thing that makes signing out worth doing.
  await page.getByTestId('account-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(`${CUSTOMER}/`);

  // A second user registers and opens the wallet — must not see A's ticket
  await page.goto(`${CUSTOMER}/register`);
  await page.getByLabel('Full name').fill('User B');
  await page.getByLabel('Email').fill(uniqueEmail('userB'));
  await page.getByLabel(/Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/, { timeout: 20_000 });

  await expect(page.getByText(/wallet is empty/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('link', { name: /View ticket/ })).toHaveCount(0);
});
