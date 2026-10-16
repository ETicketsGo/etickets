import { test, expect, type Page } from '@playwright/test';
import { API, CUSTOMER, NEW_ACCOUNT_PASSWORD, chooseEmailSignUp } from './helpers';

/**
 * The signup page as a carrier reviewer sees it, and the ways a person can fill it in.
 *
 * -- WHY THE PUBLIC PAGE MATTERS AS MUCH AS THE BEHAVIOUR --------------------------------
 * This route is the opt-in proof submitted with the A2P campaign. A reviewer opens it
 * unauthenticated and has to be able to read, without clicking anything: what messages are
 * sent, how often, who pays, how to stop, how to get help, that it is not required to buy a
 * ticket, and where the terms and privacy policy are. If any of that stops rendering, the
 * campaign evidence stops being true - so it is asserted here rather than trusted.
 *
 * -- WHERE THE BOX LIVES NOW --------------------------------------------------------------
 * Sign-up has Mobile | Email tabs like sign-in (owner, 2026-10-16). The agreement belongs to
 * the Mobile tab, and only for a US number - A2P covers messages to US numbers. A reviewer in
 * the United States opens the page on the Mobile tab with United States already chosen (the
 * country follows where the visitor is), so the disclosure is there without a click. This file
 * browses from New York for exactly that reason.
 */
test.use({ timezoneId: 'America/New_York', locale: 'en-US' });

const unique = () => `a2p-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

/*
  -- WHY NOTHING HERE SELECTS BY A FIXED ID ----------------------------------------------
  The form sits in a Suspense boundary that the server STREAMS: its HTML arrives in a hidden
  `<div hidden id="S:1">` and an inline script swaps it into place. When React has already
  rendered that boundary on the client, the page holds two copies of the form for a moment.
  The page gives each copy its own ids, and this file finds controls by role and label, waits
  for the page to settle to one form, and then asserts every id it uses names one element.
*/
const consentBox = (page: Page) =>
  page.getByRole('checkbox', { name: /Send me transactional text messages/i });
const mobile = (page: Page) => ({
  name: page.getByLabel('Full name', { exact: true }),
  country: page.getByLabel('Country', { exact: true }),
  phone: page.getByLabel('Mobile number', { exact: true }),
  consent: consentBox(page),
});

/** Opens the signup page on its Mobile tab and waits until it holds exactly one form. */
async function openSignup(page: Page) {
  const res = await page.goto(`${CUSTOMER}/register`);
  await expect(page.getByRole('tab', { name: 'Mobile' })).toHaveAttribute('aria-selected', 'true');
  await expect(consentBox(page)).toBeVisible();
  await expect(page.locator('input[type="checkbox"]')).toHaveCount(1);
  const f = mobile(page);
  for (const control of Object.values(f)) {
    const id = await control.getAttribute('id');
    expect(id, 'every control on the opt-in form has an id').toBeTruthy();
    await expect(page.locator(`[id="${id}"]`), `id "${id}" names exactly one element`).toHaveCount(
      1,
    );
  }
  expect(await f.consent.getAttribute('id')).toMatch(/sms-consent$/);
  return { res, f };
}

test.describe('signup as the A2P opt-in evidence', () => {
  test('a US reviewer can see every required disclosure without clicking', async ({ page }) => {
    const { res, f } = await openSignup(page);
    expect(res?.status()).toBe(200);
    expect(page.url(), 'the opt-in page must not require a session').not.toMatch(/\/login/);
    // Chosen for them, from where they are - never a hard-coded +91.
    await expect(f.country).toHaveValue('US');

    const text = await page.locator('body').innerText();
    expect(text).toMatch(/Send me transactional text messages from ETicketsGo/i);
    expect(text).toMatch(/bookings, tickets, event updates, cancellations, refunds/i);
    expect(text).toMatch(/Message frequency varies/i);
    expect(text).toMatch(/Message and data rates may apply/i);
    expect(text).toMatch(/Reply\s+STOP\s+to opt out/i);
    expect(text).toMatch(/HELP\s+for help/i);
    expect(text).toMatch(/Consent is not a condition of purchase/i);

    await expect(f.phone).toBeVisible();
    await expect(f.consent).toBeVisible();
    for (const href of ['/terms', '/privacy']) {
      await expect(page.locator(`a[href$="${href}"]`).first()).toHaveCount(1);
    }
    expect(text).not.toMatch(/\b(TERMS|PRIVACY|SMS|REFUNDS|COOKIES)\/[A-Z]+\/v\d/);
  });

  test('the consent box is OFF by default', async ({ page }) => {
    // A pre-ticked box is not consent.
    const { f } = await openSignup(page);
    await expect(f.consent).not.toBeChecked();
  });

  test('consent is a separate control from accepting the terms', async ({ page }) => {
    await openSignup(page);
    const boxes = page.locator('input[type="checkbox"]');
    await expect(boxes).toHaveCount(1);
    await expect(boxes.first()).toHaveAccessibleName(/Send me transactional text messages/i);
  });

  test('the box is asked only for a US number', async ({ page }) => {
    // A2P covers messages to US numbers; for India the question would be about nothing.
    const { f } = await openSignup(page);
    await f.country.selectOption('IN');
    await expect(consentBox(page)).toHaveCount(0);
    await f.country.selectOption('US');
    await expect(consentBox(page)).toBeVisible();
  });

  test('the Email tab is name, email and password - and no consent box', async ({ page }) => {
    await page.goto(`${CUSTOMER}/register`);
    await chooseEmailSignUp(page);
    await expect(page.getByLabel('Full name', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Mobile number', { exact: true })).toHaveCount(0);
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
  });

  test('an account can be created with no phone and no consent', async ({ page }) => {
    // The floor: a mobile number is never required to have an account.
    await page.goto(`${CUSTOMER}/register`);
    await chooseEmailSignUp(page);
    await page.getByLabel('Full name', { exact: true }).fill('No Phone');
    await page.getByLabel('Email', { exact: true }).fill(`${unique()}@example.com`);
    await page.getByLabel('Password', { exact: true }).fill(NEW_ACCOUNT_PASSWORD);
    await page.getByRole('button', { name: /create account/i }).click();
    await page.waitForURL((u) => !u.pathname.includes('/register'), { timeout: 20000 });
  });

  test('a mobile sign-up sends the name and, only when ticked, the US agreement', async ({
    page,
  }) => {
    /*
      The browser half of the contract: what the Mobile tab sends with the code. The API half
      (name only on a nameless account, consent recorded as CUSTOMER_SIGNUP against the proven
      number) is pinned in apps/api/src/auth/phone-signup.spec.ts. The code itself is mocked:
      no text message is sent from a test.
    */
    const sent: Record<string, unknown>[] = [];
    await page.route('**/api/auth/phone/request-code', (route) =>
      route.fulfill({ json: { sent: true, expiresInMinutes: 10 } }),
    );
    await page.route('**/api/auth/phone/verify', (route) => {
      sent.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        status: 401,
        json: {
          code: 'INVALID_CREDENTIALS',
          message: 'That code is not valid. Ask for a new one.',
        },
      });
    });

    const { f } = await openSignup(page);
    await f.name.fill('Sam Lee');
    await f.phone.fill('4155550132');
    await f.consent.check();
    await page.getByRole('button', { name: /send code/i }).click();
    await page.getByLabel('6-digit code').fill('123456');
    await page.getByRole('button', { name: /create account/i }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({
      phone: '+14155550132',
      code: '123456',
      fullName: 'Sam Lee',
      smsConsent: true,
      country: 'US',
    });

    // Unticked: nothing about consent is sent at all.
    await page.getByRole('button', { name: /use a different number/i }).click();
    await f.consent.uncheck();
    await page.getByRole('button', { name: /send code/i }).click();
    await page.getByLabel('6-digit code').fill('123456');
    await page.getByRole('button', { name: /create account/i }).click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).not.toHaveProperty('smsConsent');
    expect(sent[1]).toMatchObject({ fullName: 'Sam Lee' });
  });

  test('an email sign-up writes no consent', async ({ page }) => {
    await page.goto(`${CUSTOMER}/register`);
    await chooseEmailSignUp(page);
    await page.getByLabel('Full name', { exact: true }).fill('Email Only');
    await page.getByLabel('Email', { exact: true }).fill(`${unique()}@example.com`);
    await page.getByLabel('Password', { exact: true }).fill(NEW_ACCOUNT_PASSWORD);
    await page.getByRole('button', { name: /create account/i }).click();
    await page.waitForURL((u) => !u.pathname.includes('/register'), { timeout: 20000 });

    const consent = await page.evaluate(async (apiBase) => {
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
      expect(sms?.granted).toBeFalsy();
    }
  });

  test.describe('while the deployment cannot text anybody yet', () => {
    /*
      The state the carrier reviews in: the campaign is not approved, so no number can be sent a
      code (production today). The disclosure must still be there, word for word, on the page
      they open - disabled, with a line saying sign-up by text opens later - and the Email tab
      must still create an account.
    */
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/capabilities', (route) =>
        route.fulfill({ json: { phoneSignIn: true, phoneSignInCountries: [] } }),
      );
    });

    test('a US reviewer still reads the full disclosure without clicking', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const res = await page.goto(`${CUSTOMER}/register`);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole('tab', { name: 'Mobile' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByLabel('Country', { exact: true })).toHaveValue('US');
      await expect(page.getByTestId('phone-sms-unavailable')).toBeVisible();
      await expect(page.getByTestId('sms-opens-later')).toBeVisible();

      const box = consentBox(page);
      await expect(box).toBeVisible();
      await expect(box).toBeDisabled();
      await expect(box).not.toBeChecked();

      const text = await page.locator('body').innerText();
      expect(text).toMatch(/Send me transactional text messages from ETicketsGo/i);
      expect(text).toMatch(/bookings, tickets, event updates, cancellations, refunds/i);
      expect(text).toMatch(/Message frequency varies/i);
      expect(text).toMatch(/Message and data rates may apply/i);
      expect(text).toMatch(/Reply\s+STOP\s+to opt out/i);
      expect(text).toMatch(/HELP\s+for help/i);
      expect(text).toMatch(/Consent is not a condition of purchase/i);
      for (const href of ['/terms', '/privacy']) {
        await expect(page.locator(`a[href$="${href}"]`).first()).toHaveCount(1);
      }
      // Nothing that could only fail: no number box, no Send code.
      await expect(page.getByLabel('Mobile number', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /send code/i })).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('the Email tab still creates an account', async ({ page }) => {
      await page.goto(`${CUSTOMER}/register`);
      await page.getByRole('button', { name: 'Use email instead' }).click();
      await page.getByLabel('Full name', { exact: true }).fill('Reviewer Email');
      await page.getByLabel('Email', { exact: true }).fill(`${unique()}@example.com`);
      await page.getByLabel('Password', { exact: true }).fill(NEW_ACCOUNT_PASSWORD);
      await page.getByRole('button', { name: /create account/i }).click();
      await page.waitForURL((u) => !u.pathname.includes('/register'), { timeout: 20000 });
    });

    test('the public text-message page loads without errors', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const res = await page.goto(`${CUSTOMER}/sms`);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: /text messages/i }).first()).toBeVisible();
      expect(errors).toEqual([]);
    });
  });
});
