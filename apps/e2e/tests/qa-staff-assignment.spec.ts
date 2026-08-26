import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type APIRequestContext,
} from '@playwright/test';

/**
 * Handing somebody a duty by clicking, on QA, and taking it away again.
 *
 * The API path for this is covered by an integration test and the screen's rendering by
 * `qa-validate`. Neither covers the click path, which is the half an administrator actually
 * uses — and the half where a mutation can fire against the wrong id, a dialog can fail to
 * refresh the list, or a change can appear to save and not.
 *
 * Leaves QA as it found it: the account it promotes is demoted again at the end, and the
 * test fails if it cannot.
 */
const ADMIN = 'https://admin-web-qa.up.railway.app';
const API = 'https://api-qa-f580.up.railway.app/api';
const PW = 'Password123!';

/** Seeded, ordinary, and not a member of any back-office group to begin with. */
const CANDIDATE = 'customer1@eticketsgo.test';

async function auth(context: BrowserContext, request: APIRequestContext) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: 'admin@eticketsgo.test', password: PW },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  await context.addInitScript((t) => {
    localStorage.setItem('etg_access', t.accessToken);
    localStorage.setItem('etg_refresh', t.refreshToken);
  }, body);
  return body.accessToken as string;
}

const open = (page: Page, url: string) => page.goto(url, { waitUntil: 'networkidle' });

test.describe('QA: assigning a duty by clicking', () => {
  let token = '';

  test.afterAll(async ({ request }) => {
    /*
      Put QA back.

      A validation run that leaves a customer holding back-office access is worse than no
      run: the next person to look at the staff list sees a stranger on it and cannot tell
      whether it was deliberate.
    */
    if (!token) return;
    const users = await (
      await request.get(`${API}/users?page=1&pageSize=5&q=customer1`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    const id = (users.data ?? users)[0]?.id;
    if (id) {
      await request.delete(`${API}/admin/staff/${id}/admin-role`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  });

  test('promote to a refund desk, confirm the limits, then take it back', async ({
    page,
    context,
    request,
  }) => {
    token = await auth(context, request);
    await open(page, `${ADMIN}/admin/staff`);

    // ── Grant, through the dialog an administrator actually uses ──
    await page.getByRole('button', { name: 'Add staff' }).click();
    await page.getByRole('button', { name: 'Refund desk' }).click();
    await page.getByPlaceholder(/Find someone by name or email/).fill('customer1');

    /*
      Scoped to the dialog, not to a div that happens to contain the email.

      `locator('div').filter({hasText})` matches every ancestor div too, and `.last()` picks
      the innermost — which holds the text and not the button beside it. The search is
      narrowed to one person, so the dialog's own Grant button is unambiguous.
    */
    const grant = page.getByRole('dialog').getByRole('button', { name: 'Grant access' });
    await expect(grant).toHaveCount(1, { timeout: 20_000 });
    await grant.click();

    // The dialog closes on success, so a second click cannot grant the same duty twice.
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });

    // The list has to reflect it without a reload — a screen that saves silently and shows
    // the old state invites somebody to click again.
    const list = page.getByRole('main');
    await expect(list.getByText(CANDIDATE)).toBeVisible({ timeout: 20_000 });

    /*
      What was actually granted is asserted against the SERVER, not by reading chips.

      The chips are ambiguous by nature: the super admin's row lists all twelve permissions,
      so "is Refund review on screen" is true whether or not this person has it. The screen's
      rendering is covered in `qa-validate`; what matters here is that a click produced the
      right grant, and only the API can say that.

      And the duty it did NOT grant is the point of the whole feature: a refund desk may
      investigate and may not pay out. REFUND_APPROVE missing from this list is the assertion.
    */
    const staff = await (
      await request.get(`${API}/admin/staff`, { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    const granted = staff.find((u: { email: string }) => u.email === CANDIDATE);
    expect(granted?.permissions.sort()).toEqual([
      'BOOKING_READ',
      'ORGANIZER_READ',
      'REFUND_REVIEW',
    ]);

    // ── Revoke, through the same screen ──
    // Only one non-super account is on the list, so its Remove button is unambiguous —
    // asserted rather than assumed, because clicking the wrong one removes real access.
    const remove = page.getByRole('button', { name: /Remove access/ });
    await expect(remove).toHaveCount(1);
    await remove.click();
    await expect(page.getByRole('main').getByText(CANDIDATE)).toHaveCount(0, { timeout: 20_000 });
  });
});
