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

test('attendee identity: owner invites, recipient claims, ticket moves to their wallet', async ({
  page,
}) => {
  // Owner registers and books one ticket
  await page.goto(`${CUSTOMER}/register`);
  await page.getByLabel('Full name').fill('Owner Olive');
  await page.getByLabel('Email').fill(uniqueEmail('owner'));
  await page.getByLabel(/Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/, { timeout: 20_000 });

  await page.goto(`${CUSTOMER}/events`);
  await page.locator('a[href^="/events/"]').first().click();
  await expect(page).toHaveURL(/\/events\/.+/);
  const qty = page.locator('select[aria-label^="Quantity"]').first();
  await qty.selectOption('1');
  await page.getByRole('button', { name: /Continue to payment/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
  await page.getByRole('button', { name: /Pay/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });
  await page.getByRole('link', { name: 'View my ticket' }).click();

  // Open the ticket viewer and invite an attendee by email
  await page.getByRole('link', { name: /View ticket/ }).click();
  await expect(page).toHaveURL(/\/account\/bookings\/.+\/tickets/);
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  const attendeeEmail = uniqueEmail('attendee');
  await page.getByLabel('Attendee email').fill(attendeeEmail);
  await page.getByRole('button', { name: 'Send invitation' }).click();

  // Copy the generated claim link, then leave the owner session
  const inviteLink = await page.getByLabel('Invitation link').inputValue();
  expect(inviteLink).toContain('/invite/');
  await page.evaluate(() => localStorage.clear());

  // Recipient registers, then claims the ticket
  await page.goto(`${CUSTOMER}/register`);
  await page.getByLabel('Full name').fill('Rita Recipient');
  await page.getByLabel('Email').fill(attendeeEmail);
  await page.getByLabel(/Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/, { timeout: 20_000 });

  await page.goto(inviteLink);
  await page.getByRole('button', { name: 'Accept ticket' }).click();
  await expect(page.getByText('Ticket added to your wallet')).toBeVisible({ timeout: 20_000 });

  // The claimed ticket now appears in the recipient's wallet
  await page.getByRole('link', { name: 'Go to my tickets' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/);
  await expect(page.getByRole('article')).toHaveCount(1);
});

test('secure sharing: owner creates a guest link, recipient opens it, then it is revoked', async ({
  page,
}) => {
  // Owner registers and books one ticket
  await page.goto(`${CUSTOMER}/register`);
  await page.getByLabel('Full name').fill('Share Owner');
  await page.getByLabel('Email').fill(uniqueEmail('sharer'));
  await page.getByLabel(/Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/, { timeout: 20_000 });

  await page.goto(`${CUSTOMER}/events`);
  await page.locator('a[href^="/events/"]').first().click();
  await page.locator('select[aria-label^="Quantity"]').first().selectOption('1');
  await page.getByRole('button', { name: /Continue to payment/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
  await page.getByRole('button', { name: /Pay/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });
  await page.getByRole('link', { name: 'View my ticket' }).click();
  await page.getByRole('link', { name: /View ticket/ }).click();
  await expect(page).toHaveURL(/\/account\/bookings\/.+\/tickets/);
  const viewerUrl = page.url();

  // Create a GUEST share link
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.locator('input[value="GUEST"]').check();
  await page.getByRole('button', { name: 'Create link' }).click();
  const shareLink = await page.getByLabel('Share link').inputValue();
  expect(shareLink).toContain('/share/');

  // Recipient opens the guest link — sees the live QR
  await page.goto(shareLink);
  await expect(page.getByText('Shared with you')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('img[alt="Ticket QR code"]')).toBeVisible();

  // Owner revokes the share
  await page.goto(viewerUrl);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke' }).first().click();
  await expect(page.getByText(/Share revoked/i)).toBeVisible({ timeout: 20_000 });

  // The link no longer works
  await page.goto(shareLink);
  await expect(page.getByText('This share has been revoked.')).toBeVisible({ timeout: 20_000 });
});
