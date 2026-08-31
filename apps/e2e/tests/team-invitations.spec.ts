import { test, expect } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth, SEED_PASSWORD, uniqueEmail } from './helpers';

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
 */
const OWNER_EMAIL = 'owner@eticketsgo.test';

test.describe('adding a staff member', () => {
  test.describe.configure({ mode: 'serial' });

  let owner: Awaited<ReturnType<typeof apiLogin>>;
  let organizationId = '';
  const staffEmail = uniqueEmail('newstaff');
  let inviteUrl = '';

  test.beforeAll(async ({ request }) => {
    // Minted once — the auth throttle is deliberately tight and is not weakened for a test.
    owner = await apiLogin(request, OWNER_EMAIL);
    const orgs = await (
      await request.get(`${API}/organizations`, {
        headers: { Authorization: `Bearer ${owner.accessToken}` },
      })
    ).json();
    organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  });

  test('1: the owner adds someone and is handed a link to send them', async ({ page, context }) => {
    await seedBrowserAuth(context, owner);
    await page.goto(`${ORGANIZER}/organizer/team`, { waitUntil: 'networkidle' });

    // The permission is the decision being made, so the console says what each one grants
    // rather than only printing a role code.
    await expect(page.getByText('Scan tickets at the door')).toBeVisible({ timeout: 30_000 });

    await page.getByLabel('Email').fill(staffEmail);
    await page.getByLabel('Role').selectOption('CHECKIN_STAFF');
    await page.getByRole('button', { name: 'Create invitation' }).click();

    /*
      The link is shown, not merely emailed. `EMAIL_PROVIDER=log` swallows mail in every
      environment configured so far, so an invitation that only goes by email is the same
      dead end wearing a new costume.
    */
    const field = page.getByLabel('Invitation link');
    await expect(field).toBeVisible({ timeout: 30_000 });
    inviteUrl = await field.inputValue();
    expect(inviteUrl).toContain('/invite/');

    // And they are listed as not yet joined, rather than silently looking like a member.
    // Regex, not a literal: the page renders a typographic apostrophe, not an ASCII one.
    await expect(page.getByText(/Hasn.t joined yet/).first()).toBeVisible();
  });

  test('2: before accepting, the account cannot sign in at all', async ({ request }) => {
    /*
      The security property, and the reason the old behaviour could not simply be "make them
      ACTIVE immediately": being named by somebody else is not consent, and an account that
      exists but was never claimed must not be usable.
    */
    const res = await request.post(`${API}/auth/login`, {
      data: { email: staffEmail, password: SEED_PASSWORD },
    });
    expect(res.ok()).toBe(false);
  });

  test('3: the invitee opens the link, sets a password, and joins', async ({ page }) => {
    const path = new URL(inviteUrl).pathname;
    await page.goto(`${ORGANIZER}${path}`, { waitUntil: 'networkidle' });

    await expect(page.getByRole('heading', { name: /^Join / })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(staffEmail)).toBeVisible();

    await page.getByLabel('Your name').fill('New Staffer');
    await page.getByLabel('Choose a password').fill(SEED_PASSWORD);
    await page.getByRole('button', { name: 'Create account and join' }).click();

    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  });

  test('4: and now they can sign in and reach the organization', async ({ request }) => {
    /*
      What the whole feature is for, and what was broken: `assertMember` requires ACTIVE, and
      nothing used to set it. Asserted against the API rather than the UI, because a console
      that renders a team list proves nothing about whether the server would let them act.
    */
    const staff = await apiLogin(request, staffEmail);
    expect(staff.accessToken).toBeTruthy();

    const res = await request.get(`${API}/organizations`, {
      headers: { Authorization: `Bearer ${staff.accessToken}` },
    });
    expect(res.ok()).toBe(true);
    const orgs = await res.json();
    const list = Array.isArray(orgs) ? orgs : orgs.data;
    expect(list.map((o: { id: string }) => o.id)).toContain(organizationId);
  });

  test('5: the link is spent, and says something useful when reused', async ({ page }) => {
    const path = new URL(inviteUrl).pathname;
    await page.goto(`${ORGANIZER}${path}`, { waitUntil: 'networkidle' });

    await expect(page.getByRole('heading', { name: /can.t be used/i })).toBeVisible({
      timeout: 30_000,
    });
    // The server's own wording, which points at the next thing to try rather than just
    // reporting failure.
    await expect(page.getByText(/already have been used/i)).toBeVisible();
  });
});
