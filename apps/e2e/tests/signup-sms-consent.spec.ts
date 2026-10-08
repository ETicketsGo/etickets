import { test, expect } from '@playwright/test';
import { API, CUSTOMER, NEW_ACCOUNT_PASSWORD } from './helpers';

/**
 * The signup page as a carrier reviewer sees it, and the four ways a person can fill it in.
 *
 * -- WHY THE PUBLIC PAGE MATTERS AS MUCH AS THE BEHAVIOUR --------------------------------
 * This route is the opt-in proof submitted with the A2P campaign. A reviewer opens it
 * unauthenticated and has to be able to read, without clicking anything: what messages are
 * sent, how often, who pays, how to stop, how to get help, that it is not required to buy a
 * ticket, and where the terms and privacy policy are. If any of that stops rendering, the
 * campaign evidence stops being true - so it is asserted here rather than trusted.
 */

const unique = () => `a2p-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

test.describe('signup as the A2P opt-in evidence', () => {
  test('a reviewer can see every required disclosure without signing in', async ({ page }) => {
    const res = await page.goto(`${CUSTOMER}/register`);
    expect(res?.status()).toBe(200);
    expect(page.url(), 'the opt-in page must not require a session').not.toMatch(/\/login/);

    /*
      The form renders inside a Suspense boundary: the server sends a "Loading..." card and the
      form mounts after hydration. Reading the body as soon as navigation settles raced that,
      and failed main twice (9c4913c, f4ef929) on an unchanged page. Wait for the form, then
      read what a reviewer reads.
    */
    await expect(page.locator('#sms-consent')).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text).toMatch(/Send me transactional text messages from ETicketsGo/i);
    expect(text).toMatch(/bookings, tickets, event updates, cancellations, refunds/i);
    expect(text).toMatch(/Message frequency varies/i);
    expect(text).toMatch(/Message and data rates may apply/i);
    expect(text).toMatch(/Reply\s+STOP\s+to opt out/i);
    expect(text).toMatch(/HELP\s+for help/i);
    expect(text).toMatch(/Consent is not a condition of purchase/i);

    // The controls themselves.
    await expect(page.locator('#phone')).toBeVisible();
    await expect(page.locator('#phone-country')).toBeVisible();
    await expect(page.locator('#sms-consent')).toBeVisible();
    await expect(page.getByRole('button', { name: /create account/i })).toBeVisible();

    // Policy links, adjacent to the disclosure and actually resolving.
    for (const href of ['/terms', '/privacy']) {
      await expect(page.locator(`a[href$="${href}"]`).first()).toHaveCount(1);
    }

    // Nothing internal leaks onto the page a reviewer reads.
    expect(text).not.toMatch(/\b(TERMS|PRIVACY|SMS|REFUNDS|COOKIES)\/[A-Z]+\/v\d/);
  });

  test('the consent box is OFF by default', async ({ page }) => {
    /*
      The single most important assertion in this file. A pre-ticked box is not consent, and
      a campaign submitted on the strength of a form that pre-ticks it is submitted on a
      false claim.
    */
    await page.goto(`${CUSTOMER}/register`);
    await expect(page.locator('#sms-consent')).not.toBeChecked();
  });

  test('consent is a separate control from accepting the terms', async ({ page }) => {
    // There is exactly one checkbox on this form, and it is the SMS one. Accepting the terms
    // is not a checkbox that could be bundled with it.
    await page.goto(`${CUSTOMER}/register`);
    const boxes = page.locator('input[type="checkbox"]');
    await expect(boxes).toHaveCount(1);
    await expect(boxes.first()).toHaveAttribute('id', 'sms-consent');
  });

  test('ticking the box with no number complains about the NUMBER', async ({ page }) => {
    /*
      The error belongs on the empty field. Pointing at the checkbox would tell somebody to
      undo the thing they just asked for.
    */
    await page.goto(`${CUSTOMER}/register`);
    await page.locator('#name').fill('A Reviewer');
    await page.locator('#email').fill(`${unique()}@example.com`);
    await page.locator('#password').fill(NEW_ACCOUNT_PASSWORD);
    await page.locator('#sms-consent').check();
    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page.locator('body')).toContainText(/Add your mobile number/i);
    // And it did not navigate: no account was created on an unsatisfiable consent.
    expect(page.url()).toMatch(/\/register/);
  });

  test('an account can be created with no phone and no consent', async ({ page }) => {
    // The floor: a mobile number is never required to have an account.
    await page.goto(`${CUSTOMER}/register`);
    await page.locator('#name').fill('No Phone');
    await page.locator('#email').fill(`${unique()}@example.com`);
    await page.locator('#password').fill(NEW_ACCOUNT_PASSWORD);
    await page.getByRole('button', { name: /create account/i }).click();

    await page.waitForURL((u) => !u.pathname.includes('/register'), { timeout: 20000 });
    expect(page.url()).not.toMatch(/\/register/);
  });

  test('a number WITHOUT the box still creates the account, and grants nothing', async ({
    page,
  }) => {
    /*
      Giving us a number is not asking to be texted. If this ever started failing - or
      started writing a consent row - the platform would be inferring agreement from a
      contact detail, which is the thing the consent record exists to make impossible.
    */
    await page.goto(`${CUSTOMER}/register`);
    await page.locator('#name').fill('Phone No Consent');
    await page.locator('#email').fill(`${unique()}@example.com`);
    await page.locator('#password').fill(NEW_ACCOUNT_PASSWORD);
    await page.locator('#phone-country').selectOption('US');
    await page.locator('#phone').fill('5551234567');
    await expect(page.locator('#sms-consent')).not.toBeChecked();
    await page.getByRole('button', { name: /create account/i }).click();

    await page.waitForURL((u) => !u.pathname.includes('/register'), { timeout: 20000 });
    expect(page.url()).not.toMatch(/\/register/);
  });

  test('a number WITH the box creates the account and records the consent', async ({ page }) => {
    await page.goto(`${CUSTOMER}/register`);
    await page.locator('#name').fill('Phone And Consent');
    await page.locator('#email').fill(`${unique()}@example.com`);
    await page.locator('#password').fill(NEW_ACCOUNT_PASSWORD);
    await page.locator('#phone-country').selectOption('US');
    await page.locator('#phone').fill('5551234567');
    await page.locator('#sms-consent').check();
    await page.getByRole('button', { name: /create account/i }).click();

    await page.waitForURL((u) => !u.pathname.includes('/register'), { timeout: 20000 });

    /*
      Read the consent back as the person themselves, which is also what a data-subject
      request returns. `sms:transactional` is the scope the checkbox promises; a granted
      `sms` row would mean promotional messages nobody agreed to.
    */
    const consent = await page.evaluate(async (apiBase) => {
      // `apiBase` is passed IN: `process` does not exist in a browser, and reading it here
      // throws a ReferenceError that reads like the request failed.
      const token = window.localStorage.getItem('etg_access');
      const res = await fetch(`${apiBase}/me/marketing-consent`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.ok ? await res.json() : null;
    }, API);

    if (consent) {
      const sms = consent.channels?.find(
        (c: { channel: string }) => c.channel === 'sms:transactional',
      );
      expect(sms?.granted, 'transactional SMS consent must be recorded').toBe(true);
      const marketing = consent.channels?.find((c: { channel: string }) => c.channel === 'sms');
      expect(marketing?.granted, 'marketing SMS must NOT be granted by this box').toBeFalsy();
    }
  });
});
