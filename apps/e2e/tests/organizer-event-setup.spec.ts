import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ADMIN, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * Setting an event up without typing things a list could have offered.
 *
 * ── THE TWO COMPLAINTS THIS ANSWERS ────────────────────────────────────────────────
 * "When we are creating event, instead of typing all the details it is good to have an
 * option or dropdown list" — and "event should have an is-it-a-free-event option".
 *
 * The category dropdown is not only about saving keystrokes. Browse builds its category list
 * with `distinct` over that column, so every typo and case variant an organizer ever typed
 * became its own row on the customer's front page.
 *
 * ── AND WHO IS ALLOWED TO SKIP REVIEW ──────────────────────────────────────────────
 * "It is hard to approve each and every event — let's have a toggle on the orgs." The toggle
 * lives in the ADMIN console, because trust is the platform's judgement about the organizer,
 * not a setting the organizer owns.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';
const ADMIN_EMAIL = 'admin@eticketsgo.test';

async function tokens(request: APIRequestContext, email: string) {
  return apiLogin(request, email);
}

test.describe('creating an event', () => {
  // Minted once — the auth throttle is deliberately tight and is not weakened for a test.
  let organizerTokens: Awaited<ReturnType<typeof apiLogin>>;

  test.beforeAll(async ({ request }) => {
    organizerTokens = await tokens(request, ORGANIZER_EMAIL);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, organizerTokens);
  });

  test('1: the category is picked from a list, with a way out for anything else', async ({
    page,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/events/new`, { waitUntil: 'networkidle' });

    const category = page.getByLabel('Category');
    await expect(category).toBeVisible({ timeout: 30_000 });
    await category.selectOption('Comedy');

    /*
      "Something else…" stays, and reveals a text box. A list that cannot express what
      somebody is actually running just gets the nearest wrong answer picked, which is worse
      for browse than a new value typed on purpose.
    */
    await expect(page.getByLabel('Your category')).toBeHidden();
    await category.selectOption('__other');
    await expect(page.getByLabel('Your category')).toBeVisible();
  });

  test('2: marking it free removes every price from the rest of the wizard', async ({
    page,
    request,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/events/new`, { waitUntil: 'networkidle' });

    await page.getByLabel('Event title').fill('Community Open Day');
    await page.getByLabel('Category').selectOption('Community');
    const free = page.getByLabel('This is a free event');
    await expect(free).toBeVisible();
    await free.check();
    await expect(page.getByText('no booking fee and no platform share')).toBeVisible();

    // `exact` because the Next.js dev-tools button in the corner also matches "Next".
    // Straight through venue and sessions to the money.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByLabel('Venue').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.locator('#ss0').fill(dayAfter(300));
    await page.locator('#ss0-time').selectOption('18:00');
    await page.locator('#se0').fill(dayAfter(300));
    await page.locator('#se0-time').selectOption('20:00');
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    /*
      The price is disabled and pinned at zero, rather than hidden. Removing the field would
      leave "where did the price go?" unanswered in the place it is asked.
    */
    const price = page.locator('#tp0');
    await expect(price).toBeDisabled();
    await expect(price).toHaveValue('0');
    await expect(page.getByText('Free event — attendees pay nothing.')).toBeVisible();

    // And fee handling is a question with no true answer on a free event, so it is not asked.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('No fees on a free event')).toBeVisible();
    await expect(page.getByLabel('Fee handling')).toBeHidden();

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Free — no payment taken')).toBeVisible();

    /*
      And it is actually created that way.

      Stopping at the review screen would only prove the wizard renders. What matters is what
      the commit sends: the free flag ON and every ticket type at zero — the API refuses the
      two in disagreement, so a wizard that sent a stale price box would fail the whole
      creation with an error about something the organizer cannot see.
    */
    await page.getByRole('button', { name: 'Save draft' }).click();
    /*
      `[^/]+` alone also matches the page we are standing on — /organizer/events/NEW — so it
      passed instantly and the id read back was the literal string "new". Excluding it is
      what makes this wait for the redirect rather than for nothing.
    */
    await expect(page).toHaveURL(/\/organizer\/events\/(?!new$)[^/]+$/, { timeout: 30_000 });

    const eventId = page.url().split('/').pop()!;
    const res = await request.get(`${API}/events/${eventId}`, {
      headers: { Authorization: `Bearer ${organizerTokens.accessToken}` },
    });
    const detail = await res.json();
    // The body in the message, so a failure here names what went wrong instead of
    // reporting `undefined` and leaving the reader to guess which request failed.
    expect(res.ok(), `GET /events/${eventId} → ${res.status()} ${JSON.stringify(detail)}`).toBe(
      true,
    );
    expect(detail.isFree).toBe(true);
    expect(
      detail.sessions[0].ticketTypes.every((t: { priceMinor: number }) => t.priceMinor === 0),
    ).toBe(true);
  });
});

test.describe('trusting an organizer to publish without review', () => {
  let adminTokens: Awaited<ReturnType<typeof apiLogin>>;
  let orgId = '';

  test.beforeAll(async ({ request }) => {
    adminTokens = await tokens(request, ADMIN_EMAIL);
    /*
      The organizer's OWN organization, not whichever one the admin list returns first.

      Both actors have to act on the same organization here — the admin grants the trust and
      the organizer then submits an event under it. Picking from the admin list happened to
      line up on a single-org seed and stopped lining up the moment QA had more than one:
      the organizer had no membership of the org the admin had picked, so it had no venues
      and no history of approved events, and two tests failed for a reason unrelated to what
      they check.
    */
    const orgTokens = await tokens(request, ORGANIZER_EMAIL);
    const mine = await (
      await request.get(`${API}/organizations`, {
        headers: { Authorization: `Bearer ${orgTokens.accessToken}` },
      })
    ).json();
    orgId = (Array.isArray(mine) ? mine : mine.data)[0].id;
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, adminTokens);
  });

  test('1: the control is in the admin console, and says what it costs', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/organizers/${orgId}`, { waitUntil: 'networkidle' });

    await expect(page.getByRole('heading', { name: 'Publishing' })).toBeVisible({
      timeout: 30_000,
    });
    /*
      Both halves stated. The reason to do it and the reason to hesitate are the same fact
      seen from two sides, and an admin deciding needs to see both.
    */
    await expect(page.getByText(/removes a delay on every event/)).toBeVisible();
    await expect(page.getByText(/removes the check that would catch a wrong venue/)).toBeVisible();
  });

  test('2: turning it on, then off again', async ({ page, request }) => {
    await page.goto(`${ADMIN}/admin/organizers/${orgId}`, { waitUntil: 'networkidle' });

    const grant = page.getByRole('button', { name: 'Skip review for them' });
    await expect(grant).toBeVisible({ timeout: 30_000 });
    await grant.click();
    await expect(page.getByText('Their events will now go live without review.')).toBeVisible({
      timeout: 30_000,
    });

    // Withdrawing must never be harder than granting, so it is one click with no conditions.
    const revoke = page.getByRole('button', { name: 'Send their events back to review' });
    await expect(revoke).toBeVisible({ timeout: 30_000 });
    await revoke.click();
    await expect(page.getByText('Their events will go back through review.')).toBeVisible({
      timeout: 30_000,
    });

    // Left as it was found, so this suite can run twice.
    const after = await (
      await request.get(`${API}/admin/organizers?page=1&pageSize=50`, {
        headers: { Authorization: `Bearer ${adminTokens.accessToken}` },
      })
    ).json();
    const row = after.data.find((o: { id: string }) => o.id === orgId);
    expect(row.autoApproveEvents).toBe(false);
  });

  test('3: with it on, the next event submitted goes straight live', async ({ request }) => {
    /*
      The behaviour, not just the switch. Turning the flag on and never checking that an
      event actually skips the queue would leave the whole feature resting on a toggle that
      writes a column nobody reads.
    */
    const adminAuth = { Authorization: `Bearer ${adminTokens.accessToken}` };
    const orgAuth = {
      Authorization: `Bearer ${(await apiLogin(request, ORGANIZER_EMAIL)).accessToken}`,
    };

    const venues = await (
      await request.get(`${API}/venues?organizationId=${orgId}`, { headers: orgAuth })
    ).json();
    const venueId = (Array.isArray(venues) ? venues : venues.data)[0].id;

    const makeEvent = async () => {
      const ev = await (
        await request.post(`${API}/events`, {
          headers: orgAuth,
          data: {
            organizationId: orgId,
            title: `Trust Check ${Date.now()}`,
            category: 'Community',
            venueId,
            feeMode: 'CUSTOMER_PAYS',
          },
        })
      ).json();
      const sess = await (
        await request.post(`${API}/events/${ev.id}/sessions`, {
          headers: orgAuth,
          data: {
            startsAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
            endsAt: new Date(Date.now() + 60 * 86_400_000 + 3_600_000).toISOString(),
          },
        })
      ).json();
      await request.post(`${API}/events/ticket-types`, {
        headers: orgAuth,
        data: {
          eventSessionId: sess.id,
          name: 'Entry',
          priceMinor: 20_000,
          quantityTotal: 20,
          maxPerOrder: 4,
        },
      });
      return ev.id;
    };

    // Untrusted: the ordinary queue.
    const queued = await makeEvent();
    const before = await (
      await request.post(`${API}/events/${queued}/submit`, { headers: orgAuth })
    ).json();
    expect(before.status).toBe('UNDER_REVIEW');

    await request.patch(`${API}/admin/organizers/${orgId}/auto-approve`, {
      headers: adminAuth,
      data: { enabled: true },
    });

    const trusted = await makeEvent();
    const after = await (
      await request.post(`${API}/events/${trusted}/submit`, { headers: orgAuth })
    ).json();
    expect(after.status).toBe('PUBLISHED');
    expect(after.publishedAt).toBeTruthy();

    // Put the organizer back as it was found, so this suite can run twice.
    await request.patch(`${API}/admin/organizers/${orgId}/auto-approve`, {
      headers: adminAuth,
      data: { enabled: false },
    });
  });
});

/** A local calendar date N days out, as the date input wants it. */
function dayAfter(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
