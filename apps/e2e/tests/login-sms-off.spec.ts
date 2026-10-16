import { test, expect, type Page } from '@playwright/test';
import { CUSTOMER } from './helpers';

/**
 * When the platform declares text messages off (SMS_ENABLED=false), GET /capabilities reports
 * phoneSignIn=false and the storefront login opens on Email with no Mobile tab. When phone
 * sign-in is available the page keeps its usual Mobile-first behaviour.
 */
async function capabilities(page: Page, phoneSignIn: boolean) {
  await page.route('**/api/capabilities', (route) => route.fulfill({ json: { phoneSignIn } }));
}

test.describe('login page and the SMS capability', () => {
  test('opens on Email and hides Mobile when SMS is off', async ({ page }) => {
    await capabilities(page, false);
    await page.goto(`${CUSTOMER}/login`);
    await expect(page.getByTestId('phone-signin-off')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Mobile' })).toHaveCount(0);
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await page.screenshot({ path: `test-results/login-sms-off-${page.viewportSize()?.width}.png` });
  });

  test('keeps Mobile first when SMS is available', async ({ page }) => {
    await capabilities(page, true);
    await page.goto(`${CUSTOMER}/login`);
    await expect(page.getByRole('tab', { name: 'Mobile' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('tab', { name: 'Email' })).toBeVisible();
    await expect(page.getByTestId('phone-signin-off')).toHaveCount(0);
  });

  test('says plainly when a code cannot reach the visitor country, and offers Email', async ({
    page,
  }) => {
    // The suite browses from Asia/Kolkata, so the country opens on India.
    await page.route('**/api/capabilities', (route) =>
      route.fulfill({ json: { phoneSignIn: true, phoneSignInCountries: ['US', 'CA'] } }),
    );
    await page.goto(`${CUSTOMER}/login`);
    await expect(page.getByLabel('Country', { exact: true })).toHaveValue('IN');
    const notice = page.getByTestId('phone-sms-unavailable');
    await expect(notice).toContainText('India');
    // No number box and no Send button: nothing that can only fail.
    await expect(page.getByLabel('Mobile number', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send code' })).toHaveCount(0);
    // A country we can text brings the form back.
    await page.getByLabel('Country', { exact: true }).selectOption('US');
    await expect(notice).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();
    await page.getByLabel('Country', { exact: true }).selectOption('IN');
    await page.getByRole('button', { name: 'Use email instead' }).click();
    await expect(page.getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  test('turns a 503 SMS_UNAVAILABLE into the same way out', async ({ page }) => {
    await capabilities(page, true);
    await page.route('**/api/auth/phone/request-code', (route) =>
      route.fulfill({
        status: 503,
        json: { code: 'SMS_UNAVAILABLE', message: "We can't send sign-in codes right now." },
      }),
    );
    await page.goto(`${CUSTOMER}/login`);
    await page.getByLabel('Mobile number', { exact: true }).fill('8121234567');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByTestId('phone-sms-unavailable')).toBeVisible();
    await page.getByRole('button', { name: 'Use email instead' }).click();
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  test('sign-up with no number reachable opens on Email for a non-US visitor', async ({ page }) => {
    // The suite browses from Asia/Kolkata. Sign-up keeps its Mobile tab (the A2P disclosure
    // lives there for US visitors) but nobody else is opened on a form that cannot send.
    await page.route('**/api/capabilities', (route) =>
      route.fulfill({ json: { phoneSignIn: true, phoneSignInCountries: [] } }),
    );
    await page.goto(`${CUSTOMER}/register`);
    await expect(page.getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Mobile' }).click();
    await expect(page.getByTestId('phone-sms-unavailable')).toBeVisible();
    // Not a US number: no agreement to show.
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
  });
});
