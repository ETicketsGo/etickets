import { test, expect } from '@playwright/test';
import { CUSTOMER, SEED_PASSWORD, uniqueEmail } from './helpers';
import { openPaidEvent } from './pick-event';

test('customer registers, books a ticket, pays, and sees a QR ticket', async ({ page }) => {
  // Register
  await page.goto(`${CUSTOMER}/register`);
  await page.getByLabel('Full name').fill('E2E Customer');
  await page.getByLabel('Email').fill(uniqueEmail('cust'));
  await page.getByLabel(/Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/, { timeout: 20_000 });

  // Browse and open an event that charges for a ticket — this test goes on to pay.
  await page.goto(`${CUSTOMER}/events`);
  await openPaidEvent(page);
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
  /*
    The QR is on the confirmation itself now — no second click.

    This used to assert only that a link to the wallet existed, which is a weaker claim: it
    proved a route was reachable, not that the buyer had their ticket. Both tickets from this
    two-ticket booking must be here.
  */
  const qrs = page.getByRole('img', { name: /Entry QR code/i });
  await expect(qrs.first()).toBeVisible({ timeout: 30_000 });
  await expect(qrs).toHaveCount(2);
  await expect(qrs.first()).toHaveAttribute('src', /^data:image\//);

  // Ticket wallet: the multi-ticket booking shows as ONE booking group card
  await page.getByRole('link', { name: 'All my tickets' }).click();
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
  await openPaidEvent(page);
  await expect(page).toHaveURL(/\/events\/.+/);
  const qty = page.locator('select[aria-label^="Quantity"]').first();
  await qty.selectOption('1');
  await page.getByRole('button', { name: /Continue to payment/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
  await page.getByRole('button', { name: /Pay/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });
  await page.getByRole('link', { name: 'All my tickets' }).click();

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
  await openPaidEvent(page);
  await page.locator('select[aria-label^="Quantity"]').first().selectOption('1');
  await page.getByRole('button', { name: /Continue to payment/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
  await page.getByRole('button', { name: /Pay/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });
  await page.getByRole('link', { name: 'All my tickets' }).click();
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

test('experience wallet: placeholder items appear behind a feature flag and filter', async ({
  page,
}) => {
  // Register + book a ticket
  await page.goto(`${CUSTOMER}/register`);
  await page.getByLabel('Full name').fill('Wallet User');
  await page.getByLabel('Email').fill(uniqueEmail('wallet'));
  await page.getByLabel(/Password/).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account\/tickets/, { timeout: 20_000 });

  await page.goto(`${CUSTOMER}/events`);
  await openPaidEvent(page);
  await page.locator('select[aria-label^="Quantity"]').first().selectOption('1');
  await page.getByRole('button', { name: /Continue to payment/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
  await page.getByRole('button', { name: /Pay/ }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/confirmation/, { timeout: 20_000 });

  // Wallet with placeholder items enabled via feature flag
  await page.goto(`${CUSTOMER}/account/tickets?preview=memberships,coupons`);
  await expect(page.getByRole('heading', { name: 'My experiences' })).toBeVisible();
  await expect(page.getByText('ETicketsGo Gold')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('10% Welcome Coupon')).toBeVisible();
  // The real ticket item is present too (generic card, no type branching)
  await expect(page.getByRole('link', { name: /View ticket/ })).toBeVisible();

  // Filter to Memberships → only the membership remains
  await page.getByRole('button', { name: 'Memberships' }).click();
  await expect(page.getByText('ETicketsGo Gold')).toBeVisible();
  await expect(page.getByRole('link', { name: /View ticket/ })).toHaveCount(0);
  await expect(page.getByText('10% Welcome Coupon')).toHaveCount(0);
});
