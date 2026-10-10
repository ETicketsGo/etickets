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

  test('1: what is being organized comes first, then a category from its own short list', async ({
    page,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/events/new`, { waitUntil: 'networkidle' });

    /*
      Asked first, as seven cards, each saying what it sets up. Choosing one does not move on by
      itself - arrow keys select as they move - so Continue is a separate press.
    */
    const kinds = page.getByRole('group', { name: 'Choose an experience to get started' });
    await expect(kinds).toBeVisible({ timeout: 30_000 });
    await expect(kinds.getByRole('radio')).toHaveCount(7);
    await expect(page.getByText('Sessions, registrations and passes')).toBeVisible();
    // Continue with nothing chosen says why it did not move on.
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Choose the kind of event you are organizing')).toBeVisible();

    await kinds.getByRole('radio', { name: 'Comedy or theatre' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Only this experience's categories, with the first already chosen.
    const category = page.getByRole('group', { name: 'Category' });
    await expect(category.getByRole('radio', { name: 'Comedy' })).toBeChecked();
    await expect(category.getByRole('radio')).toHaveCount(2);
    await category.getByRole('radio', { name: 'Theatre' }).check();

    /*
      "Something else" stays - under "Community or other" - and reveals a text box. A list
      that cannot express what somebody is running just gets the nearest wrong answer picked.
    */
    await page.getByRole('button', { name: 'Change kind of event' }).click();
    await page.getByRole('radio', { name: 'Community or other' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('Your category')).toBeHidden();
    await page
      .getByRole('group', { name: 'Category' })
      .getByRole('radio', { name: 'Something else' })
      .check();
    await expect(page.getByLabel('Your category')).toBeVisible();
  });

  test('1b: opening the wizard and leaving it does not offer a draft back', async ({ page }) => {
    /*
      Reported: "Picked up where you left off" over an empty form. Opening the page saved a
      draft of the blank form, and the next visit announced it. Only a draft with something
      the organizer entered is offered back.
    */
    await page.goto(`${ORGANIZER}/organizer/events/new`, { waitUntil: 'networkidle' });
    const first = page.getByRole('radio', { name: 'Concert or live music' });
    await expect(first).toBeVisible({ timeout: 30_000 });
    await page.reload({ waitUntil: 'networkidle' });
    await expect(first).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Picked up where you left off/)).toHaveCount(0);

    // Something typed IS offered back, and "Start over" throws it away.
    await first.check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Event title').fill('Half-written event');
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(/Picked up where you left off/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Event title')).toHaveValue('Half-written event');
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(page.getByRole('radio', { name: 'Concert or live music' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Picked up where you left off/)).toHaveCount(0);
  });

  test('1c: Save draft is on every step, and leaving a field points out its problem', async ({
    page,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/events/new`, { waitUntil: 'networkidle' });
    await page.getByRole('radio', { name: 'Sports' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Nothing is called a mistake before anything is typed...
    await expect(page.getByText('Title must be at least 3 characters.')).toHaveCount(0);
    // ...but leaving the field short says so, there and then.
    await page.getByLabel('Event title').fill('Go');
    await page.getByLabel('Description').focus();
    await expect(page.getByText('Title must be at least 3 characters.')).toBeVisible();
    await page.getByLabel('Event title').fill('Go Karts');
    await expect(page.getByText('Title must be at least 3 characters.')).toHaveCount(0);

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Draft saved on this device' }),
    ).toBeVisible();
    // A sports event's dates are matches.
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('group', { name: 'Match 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
    await page.evaluate(() => localStorage.removeItem('etg_event_draft'));
  });

  test('1d: a film goes to the cinema workflow instead of this form', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/events/new`, { waitUntil: 'networkidle' });
    await page.getByRole('radio', { name: 'Movie screening' }).check();
    await expect(
      page.getByRole('heading', { name: 'Films are scheduled in Movies' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add a film' })).toHaveAttribute(
      'href',
      '/organizer/movies/new',
    );
    await expect(page.getByRole('link', { name: 'Go to Movies' })).toHaveAttribute(
      'href',
      '/organizer/movies',
    );
    // No way into the event form from here: Continue is not offered for a film.
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  });

  test('2: marking it free removes every price from the rest of the wizard', async ({
    page,
    request,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/events/new`, { waitUntil: 'networkidle' });

    await page.getByRole('radio', { name: 'Community or other' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Event title').fill('Community Open Day');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Where and when: the first saved venue, and one session, by label.
    await page.getByRole('group', { name: 'Venue' }).getByRole('radio').first().check();
    const start = page
      .getByRole('group', { name: 'Session 1' })
      .getByRole('group', { name: 'Starts at' });
    await start.getByLabel('Date').fill(dayAfter(300));
    await start.getByLabel('Time').selectOption('18:00');
    await page.getByRole('button', { name: '+2h' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    /*
      Declared on the tickets step, as the first answer to "How do people get in?". Nothing
      is chosen for the organizer: the step will not move on until it is answered.
    */
    const kinds = page.getByRole('group', { name: 'How do people get in?' });
    await expect(kinds).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(
      page.getByText('Choose how people get in: free, paid or reserved seating.').first(),
    ).toBeVisible();
    await kinds.getByRole('radio', { name: 'Free event' }).check();
    await expect(page.getByText('no booking fee and no platform share')).toBeVisible();

    /*
      No price field at all. A free event's price is not a zero the organizer must leave
      alone; it is a question that does not apply, so only name and quantity are asked.
    */
    const first = page.getByRole('group', { name: 'Ticket type 1' });
    await expect(first.getByLabel('Name')).toHaveValue('General');
    await expect(first.getByLabel('Quantity on sale')).toHaveValue('100');
    await expect(first.getByLabel(/^Price/)).toHaveCount(0);

    /*
      And a free event is never asked who pays the fees, because there are none to pay. The
      question sits on Review, where a free event simply does not show it.
    */
    await page.getByRole('button', { name: 'Continue' }).click(); // details - nothing required
    await page.getByRole('button', { name: 'Continue' }).click(); // review
    await expect(page.getByText('Setup complete').first()).toBeVisible();
    await expect(page.getByText('Free - no payment taken')).toBeVisible();
    await expect(page.getByLabel('Who pays the booking fee?')).toBeHidden();
    // The buyer's view says so too, in the card's price and the fee line.
    await expect(page.getByRole('heading', { name: 'What buyers will see' })).toBeVisible();
    await expect(page.getByText('Free to book. No checkout and no fees.')).toBeVisible();

    /*
      And it is actually created that way.

      Stopping at the review screen would only prove the wizard renders. What matters is what
      the commit sends: the free flag ON and every ticket type at zero - the API refuses the
      two in disagreement, so a wizard that sent a stale price box would fail the whole
      creation with an error about something the organizer cannot see.
    */
    await page.getByRole('button', { name: 'Create draft event' }).click();
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
  /** Kept so the admin list can be asked for THIS organization rather than paged through. */
  let orgName = '';

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
    const own = (Array.isArray(mine) ? mine : mine.data)[0];
    orgId = own.id;
    orgName = own.name;
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

    /*
      Left as it was found, so this suite can run twice - and read back by SEARCHING for this
      organization rather than asking for the first fifty and hoping.

      `pageSize=50` was a bet on the platform never holding more than fifty organizations. On a
      database that had been used it held 53, this one was not among the first fifty, and the
      assertion failed on `undefined.autoApproveEvents` - a null-dereference that said nothing
      about the flag it was checking.
    */
    const after = await (
      await request.get(
        `${API}/admin/organizers?page=1&pageSize=25&q=${encodeURIComponent(orgName)}`,
        { headers: { Authorization: `Bearer ${adminTokens.accessToken}` } },
      )
    ).json();
    const row = after.data.find((o: { id: string }) => o.id === orgId);
    expect(
      row,
      `the organization this test created was not returned for "${orgName}"`,
    ).toBeTruthy();
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
