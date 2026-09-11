import { expect, test } from '@playwright/test';
import { API, CUSTOMER, NEW_ACCOUNT_PASSWORD } from './helpers';

/**
 * One email, one account; and a password worth having.
 *
 * ── WHAT THIS WALKS ────────────────────────────────────────────────────────────────
 * The API refusals a person can actually hit at sign-up, and the form that tells them why
 * before they submit. The form's meter reads the same policy function the server enforces, so
 * the last test is really about the two agreeing — a meter that approved what the server then
 * refused would teach people to ignore it.
 */

const stamp = () => `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

test.describe('account integrity', () => {
  test('1: a password on every common list is refused, with the reason under the field', async ({
    request,
  }) => {
    const res = await request.post(`${API}/auth/register`, {
      data: {
        email: `integrity_common_${stamp()}@e2e.test`,
        password: 'Password123!',
        fullName: 'Lantern Keeper',
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details.fields.password[0]).toMatch(/commonly used/i);
  });

  test('2: the same address in a different case is the same account', async ({ request }) => {
    const local = `integrity_case_${stamp()}`;
    const first = await request.post(`${API}/auth/register`, {
      data: { email: `${local}@e2e.test`, password: NEW_ACCOUNT_PASSWORD, fullName: 'First Owner' },
    });
    expect(first.status()).toBe(201);

    const second = await request.post(`${API}/auth/register`, {
      data: {
        email: `${local.toUpperCase()}@E2E.TEST`,
        password: NEW_ACCOUNT_PASSWORD,
        fullName: 'Second Owner',
      },
    });
    expect(second.status()).toBe(409);
    expect((await second.json()).code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  test('3: an address in the phone sign-in domain cannot be registered', async ({ request }) => {
    // Registering one would stop that phone number from ever signing in.
    const res = await request.post(`${API}/auth/register`, {
      data: {
        email: 'phone+919704464007@users.eticketsgo.internal',
        password: NEW_ACCOUNT_PASSWORD,
        fullName: 'Not Allowed',
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).details.fields.email).toBeTruthy();
  });

  test('4: the sign-up form says why before anything is submitted', async ({ page }) => {
    await page.goto(`${CUSTOMER}/register`, { waitUntil: 'networkidle' });

    await page.getByLabel('Full name').fill('Asha Menon');
    await page.getByLabel('Email').fill(`integrity_form_${stamp()}@e2e.test`);
    const password = page.getByLabel('Password', { exact: true });
    const submit = page.getByRole('button', { name: 'Create account' });

    await password.fill('Password123!');
    await expect(page.getByTestId('password-problem')).toContainText(/commonly used/i);
    await expect(submit).toBeDisabled();

    // Long and unusual, but made of the name typed two fields up — refused as it is typed.
    await password.fill('Menon-Harbour-Lantern-47');
    await expect(page.getByTestId('password-problem')).toContainText(/name or email/i);
    await expect(submit).toBeDisabled();

    await password.fill(NEW_ACCOUNT_PASSWORD);
    await expect(page.getByTestId('password-strength')).toContainText(/strong/i);
    await expect(page.getByTestId('password-problem')).toHaveCount(0);
    await expect(submit).toBeEnabled();
  });
});
