import { test, expect } from '@playwright/test';
import {
  API,
  ORGANIZER,
  apiLogin,
  seedBrowserAuth,
  NEW_ACCOUNT_PASSWORD,
  uniqueEmail,
} from './helpers';

/**
 * Adding a staff member, and that staff member actually getting in.
 *
 * ── THE QUESTION THIS ANSWERS ──────────────────────────────────────────────────────
 * "When I am adding staff or admin I would be able to add and give permissions instead of
 * they are signup process — how does staff sign up as a user?"
 *
 * They could not. Inviting created an OrganizationMember at status INVITED and stopped;
 * nothing anywhere moved a member to ACTIVE, and access requires ACTIVE. Worse, an invitee
 * with no account got one with a random password nobody could know, which then made
 * self-registration fail with "email already registered" — and there is no password-reset
 * flow, so the address was finished.
 *
 * The answer now is the one the question implies: the owner adds them and picks the
 * permission, and the invitee gets a link that creates their account.
 *
 * ── WHAT THE BROWSER CAN NO LONGER SEE (owner decision, 2026-10-26) ────────────────
 * The link used to be shown to the owner to copy. That made the inviter a holder of the
 * invitee's acceptance credential, so it is now emailed to the invitee ONLY, and accepting needs
 * the invitee's own session with a code-confirmed email. A browser test has no inbox, so the
 * invitee's half (claim with the emailed code, sign in, accept; reuse refused; another session
 * refused) is proven over HTTP against a real database in
 * `apps/api/src/organizations/invite-and-suspension.http.integration-postgres.spec.ts`. This
 * walk proves the owner's half: the invitation is made, the owner is told whether the email
 * left, and the page never carries the link.
 */
const OWNER_EMAIL = 'owner@eticketsgo.test';

test.describe('adding a staff member', () => {
  test.describe.configure({ mode: 'serial' });

  let owner: Awaited<ReturnType<typeof apiLogin>>;
  const staffEmail = uniqueEmail('newstaff');

  test.beforeAll(async ({ request }) => {
    // Minted once - the auth throttle is deliberately tight and is not weakened for a test.
    owner = await apiLogin(request, OWNER_EMAIL);
  });

  test('1: the owner adds someone and is told the invitation was emailed - never shown the link', async ({
    page,
    context,
  }) => {
    await seedBrowserAuth(context, owner);
    await page.goto(`${ORGANIZER}/organizer/team`, { waitUntil: 'networkidle' });

    // The permission is the decision being made, so the console says what each one grants
    // rather than only printing a role code.
    await expect(page.getByText('Scan tickets at the door')).toBeVisible({ timeout: 30_000 });

    await page.getByLabel('Email').fill(staffEmail);
    await page.getByLabel('Role').selectOption('CHECKIN_STAFF');
    const answer = page.waitForResponse(
      (r) => r.url().includes('/members') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create invitation' }).click();
    const response = await answer;

    // Whether the email left depends on this environment's mail; either way the owner is told.
    await expect(page.getByTestId('invitation-email-status')).toBeVisible({ timeout: 30_000 });
    // And never handed the credential: not in the answer, not on the page.
    expect(await response.text()).not.toContain('/invite/');
    await expect(page.getByLabel('Invitation link')).toHaveCount(0);
    expect(await page.content()).not.toContain('/invite/');

    // They are listed as not yet joined, rather than silently looking like a member.
    await expect(page.getByText(/Has not joined yet/).first()).toBeVisible();
  });

  test('2: before it is claimed, the account cannot sign in at all', async ({ request }) => {
    /*
      Being named by somebody else is not consent, and an account that exists but was never
      claimed (with a code sent to its own address) must not be usable.
    */
    const res = await request.post(`${API}/auth/login`, {
      data: { email: staffEmail, password: NEW_ACCOUNT_PASSWORD },
    });
    expect(res.ok()).toBe(false);
  });
});
