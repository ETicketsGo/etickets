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
});
