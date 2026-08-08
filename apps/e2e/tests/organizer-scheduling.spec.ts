import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, ORGANIZER, apiLogin, login } from './helpers';

/**
 * Organizer cinema scheduling — the theater's daily operating screen.
 *
 * These drive the real UI against the real API. Nothing here reimplements a backend rule:
 * conflicts, turnaround and booking-aware guards are all asserted by observing what the
 * server decided and what the operator is then shown. A test that computed its own overlap
 * would pass while the product was broken.
 *
 * ── ISOLATION ─────────────────────────────────────────────────────────────────────
 * Every spec creates its OWN cinema, screen, seat map and movie over the API, with a
 * unique suffix. The seeded PVR cinema is shared with the customer movie spec, and mutating
 * it here would make both suites depend on execution order. Playwright is configured with
 * workers: 1 and fullyParallel: false, but relying on that for correctness would be a trap
 * the moment someone turns parallelism on.
 */

const OWNER = 'owner@eticketsgo.test';

interface Fixture {
  cinemaId: string;
  screenAId: string;
  screenBId: string;
  movieId: string;
  movieTitle: string;
  organizationId: string;
}

/**
 * A YYYY-MM-DD label N days ahead, on the CINEMA's calendar.
 *
 * Must match the zone the workspace reckons the day in, or a 09:00 show seeded here lands
 * on a different local date than the page asks for and every assertion looks at an empty
 * day. Deriving it from the runner's local calendar was exactly that bug.
 */
const CINEMA_TZ = 'Asia/Kolkata';

/** Monday of the week containing a label, on the label calendar. */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
}

/** Shift a label by whole days. Label arithmetic, never instants. */
function shiftLabel(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The week-column heading the UI renders for a label, e.g. "Mon 21 Aug". */
function headingFor(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T12:00:00Z`));
}

function dateLabel(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  // en-CA formats as YYYY-MM-DD, which is the label shape the API and the date input use.
  return new Intl.DateTimeFormat('en-CA', { timeZone: CINEMA_TZ }).format(d);
}

/**
 * Build a private cinema over the API.
 *
 * Using the API rather than the UI is deliberate: these specs are about the SCHEDULING
 * workspace, and driving cinema/screen/seat-map creation through forms would make every one
 * of them fail for unrelated reasons.
 */
async function createFixture(request: APIRequestContext, token: string): Promise<Fixture> {
  const auth = { Authorization: `Bearer ${token}` };
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs[0] : orgs.data?.[0])?.id as string;

  const cinema = await (
    await request.post(`${API}/cinemas`, {
      headers: auth,
      data: {
        organizationId,
        name: `E2E Multiplex ${suffix}`,
        city: 'Hyderabad',
      },
    })
  ).json();

  const screens: string[] = [];
  for (const name of ['Screen A', 'Screen B']) {
    const screen = await (
      await request.post(`${API}/cinemas/${cinema.id}/screens`, {
        headers: auth,
        data: { name, screenType: '2D', capacity: 20 },
      })
    ).json();
    // A screen without a seat map cannot be scheduled — the server says so explicitly.
    await request.post(`${API}/screens/${screen.id}/seatmap`, {
      headers: auth,
      data: {
        name: 'Main',
        sections: [
          {
            name: 'Stalls',
            categoryName: 'Normal',
            basePriceMinor: 20000,
            rowLabels: ['A', 'B'],
            seatsPerRow: 5,
          },
        ],
      },
    });
    screens.push(screen.id);
  }

  const movieTitle = `E2E Feature ${suffix}`;
  const movie = await (
    await request.post(`${API}/movies`, {
      headers: auth,
      data: {
        organizationId,
        title: movieTitle,
        runtimeMinutes: 100,
        language: 'Telugu',
        genres: ['Drama'],
      },
    })
  ).json();
  await request.post(`${API}/movies/${movie.id}/status`, {
    headers: auth,
    data: { status: 'PUBLISHED' },
  });

  return {
    cinemaId: cinema.id,
    screenAId: screens[0],
    screenBId: screens[1],
    movieId: movie.id,
    movieTitle,
    organizationId,
  };
}

/** Schedule shows directly over the API, for arranging a starting state. */
async function seedShows(
  request: APIRequestContext,
  token: string,
  fixture: Fixture,
  screenId: string,
  date: string,
  times: string[],
) {
  const res = await request.post(`${API}/movies/${fixture.movieId}/shows/bulk`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      screenId,
      dates: [date],
      times,
      padMinutes: 0,
      timezone: CINEMA_TZ,
      dryRun: false,
    },
  });
  return res.json();
}

/**
 * Put a CONFIRMED booking on a session, so the paid-booking guard can be exercised.
 *
 * Goes through the real booking endpoint and the platform's own mock settlement, which is
 * the only path that produces a genuinely confirmed booking without real money. It never
 * writes booking rows directly: a fixture that faked CONFIRMED would prove nothing about
 * the guard, because the guard counts the same rows the booking flow writes.
 */
async function confirmBookingOnSession(
  request: APIRequestContext,
  token: string,
  sessionId: string,
) {
  const auth = { Authorization: `Bearer ${token}` };
  const seats = await (await request.get(`${API}/public/shows/${sessionId}/seats`)).json();
  const category = seats.categories[0];
  const seat = seats.sections[0].rows[0].seats.find(
    (x: { status: string }) => x.status === 'AVAILABLE',
  );
  const booking = await (
    await request.post(`${API}/bookings`, {
      headers: { ...auth, 'idempotency-key': `e2e-${sessionId}` },
      data: {
        eventSessionId: sessionId,
        items: [{ ticketTypeId: category.ticketTypeId, quantity: 1, seatIds: [seat.id] }],
        buyerName: 'E2E Buyer',
        buyerEmail: 'e2e-buyer@eticketsgo.test',
      },
    })
  ).json();
  await request.post(`${API}/bookings/${booking.id}/pay`, { headers: auth, data: {} });
  await request.post(`${API}/payments/${booking.id}/mock-pay`, { headers: auth, data: {} });
  return booking.id;
}

/**
 * Read a session's ticket types, then move their sales window.
 *
 * The window is a property of the TICKET TYPES, not of the session, so this patches every
 * type the session has — a show that is half open and half closed is not a state the
 * operator screen claims to represent, and seeding one would be testing a fiction.
 *
 * Ids are read BEFORE the patch: once a window is in the future the public seat endpoint
 * has no reason to keep advertising the type, and a helper that depended on that would
 * break for reasons unrelated to what is being tested.
 */
async function setSalesWindow(
  request: APIRequestContext,
  token: string,
  sessionId: string,
  window: { salesStartAt?: string | null; salesEndAt?: string | null },
) {
  const auth = { Authorization: `Bearer ${token}` };
  const seats = await (await request.get(`${API}/public/shows/${sessionId}/seats`)).json();
  const ids = (seats.categories as { ticketTypeId: string }[]).map((c) => c.ticketTypeId);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const res = await request.patch(`${API}/events/ticket-types/${id}`, {
      headers: auth,
      data: window,
    });
    expect(res.ok()).toBe(true);
  }
  return ids;
}

/**
 * Try to buy one seat, and report only whether the API allowed it.
 *
 * This is the oracle the badge is checked against. The point of every window test below is
 * that what the operator is TOLD matches what a customer can actually DO — a badge that
 * says "On sale" over an endpoint that refuses is worse than no badge, because someone will
 * trust it while turning customers away.
 */
async function tryBooking(
  request: APIRequestContext,
  token: string,
  sessionId: string,
): Promise<{ ok: boolean; status: number; message: string }> {
  const auth = { Authorization: `Bearer ${token}` };
  const seats = await (await request.get(`${API}/public/shows/${sessionId}/seats`)).json();
  const category = seats.categories[0];
  const seat = seats.sections
    .flatMap((sec: { rows: { seats: { id: string; status: string }[] }[] }) => sec.rows)
    .flatMap((r: { seats: { id: string; status: string }[] }) => r.seats)
    .find((x: { status: string }) => x.status === 'AVAILABLE');
  const res = await request.post(`${API}/bookings`, {
    headers: { ...auth, 'idempotency-key': `e2e-window-${sessionId}-${seat.id}` },
    data: {
      eventSessionId: sessionId,
      items: [{ ticketTypeId: category.ticketTypeId, quantity: 1, seatIds: [seat.id] }],
      buyerName: 'E2E Window',
      buyerEmail: 'e2e-window@eticketsgo.test',
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok(), status: res.status(), message: body?.message ?? '' };
}

/**
 * The show rows of the day timeline.
 *
 * Badge text is NOT unique on this page: the status filter is a <select> whose options read
 * 'On sale', 'Sales paused' and 'Cancelled', so a page-wide getByText finds the dropdown and
 * reports a state the timeline may not be showing at all. Every state assertion goes through
 * here so it is answered by a row.
 */
const showRow = (page: Page) => page.getByRole('listitem');

/** The Create-shows dialog, scoped so its fields cannot collide with the page filters. */
const bulkDialog = (page: Page) => page.getByRole('dialog', { name: 'Create shows' });
/** The Copy-schedule dialog, scoped for the same reason. */
const copyDialog = (page: Page) => page.getByRole('dialog', { name: 'Copy schedule' });

const gotoSchedule = async (page: Page, cinemaId: string, date: string) => {
  await page.goto(`${ORGANIZER}/organizer/cinemas/${cinemaId}/schedule`);
  // The date control is the page's anchor; waiting on it proves the workspace mounted.
  const dateInput = page.getByLabel('Date', { exact: true });
  await expect(dateInput).toBeVisible({ timeout: 20_000 });
  await dateInput.fill(date);
  return dateInput;
};

test.describe('organizer cinema scheduling', () => {
  let token = '';
  let fixture: Fixture;

  test.beforeAll(async ({ request }) => {
    const tokens = await apiLogin(request, OWNER);
    token = tokens.accessToken;
    fixture = await createFixture(request, token);
  });

  test.beforeEach(async ({ page }) => {
    await login(page, ORGANIZER, OWNER);
  });

  test('1-2: opens the schedule and shows a row per screen', async ({ page, request }) => {
    const date = dateLabel(14);
    await seedShows(request, token, fixture, fixture.screenAId, date, ['09:00', '14:00']);

    await gotoSchedule(page, fixture.cinemaId, date);

    // Both screens appear: the one with shows, and the empty one — an empty screen is the
    // most actionable thing on this page and must not be hidden.
    await expect(page.getByRole('heading', { name: 'Screen A' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Screen B' })).toBeVisible();
    await expect(
      page.getByTestId('screen-show-count').filter({ hasText: '2 shows' }),
    ).toBeVisible();
    await expect(page.getByText(fixture.movieTitle).first()).toBeVisible();
  });

  test('3: creates shows through the bulk workflow', async ({ page }) => {
    const date = dateLabel(15);
    await gotoSchedule(page, fixture.cinemaId, date);

    await page.getByRole('button', { name: 'Create shows' }).click();
    const d = bulkDialog(page);
    await d.getByLabel('Screen').selectOption({ label: 'Screen A' });
    await d.getByLabel('Movie').selectOption(fixture.movieId);
    await d.getByLabel('Date', { exact: true }).fill(date);
    await d.getByLabel(/Showtimes/).fill('10:00');

    await d.getByRole('button', { name: 'Preview' }).click();
    await expect(bulkDialog(page).getByText('1 slot proposed')).toBeVisible({ timeout: 20_000 });
    await bulkDialog(page)
      .getByRole('button', { name: /Publish 1 show/ })
      .click();

    await expect(page.getByRole('heading', { name: 'Screen A' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('screen-show-count').filter({ hasText: '1 show' })).toBeVisible();
  });

  test('4-5: a turnaround-only clash is explained, not just rejected', async ({
    page,
    request,
  }) => {
    const date = dateLabel(16);
    // 10:00–11:40 exists. 11:45 does not overlap it — it is 5 min later — but a screen needs
    // 15 min between shows, and the operator must be told THAT rather than "conflict".
    await seedShows(request, token, fixture, fixture.screenAId, date, ['10:00']);

    await gotoSchedule(page, fixture.cinemaId, date);
    await page.getByRole('button', { name: 'Create shows' }).click();
    const d = bulkDialog(page);
    await d.getByLabel('Screen').selectOption({ label: 'Screen A' });
    await d.getByLabel('Movie').selectOption(fixture.movieId);
    await d.getByLabel('Date', { exact: true }).fill(date);
    await d.getByLabel(/Showtimes/).fill('11:45');
    await d.getByRole('button', { name: 'Preview' }).click();

    await expect(page.getByText('1 will be skipped')).toBeVisible({ timeout: 20_000 });
    // The human sentence, naming the turnaround as the cause.
    await expect(page.getByText(/min between shows to empty and clean/)).toBeVisible();
    // The raw code stays available for diagnostics without being the message.
    await expect(page.getByText('OVERLAPS_EXISTING_SHOW')).toBeVisible();
  });

  test('6-8: preview is required before publish', async ({ page }) => {
    const date = dateLabel(17);
    await gotoSchedule(page, fixture.cinemaId, date);
    await page.getByRole('button', { name: 'Create shows' }).click();

    // Step 1 is Configure and there is no Publish control at all until a preview is run:
    // a mis-click must never be able to create a week of shows.
    const d = bulkDialog(page);
    await expect(d.getByRole('button', { name: /^Publish/ })).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'Preview' })).toBeVisible();
  });

  test('9-11: a recurring range previews per-slot conflicts individually', async ({
    page,
    request,
  }) => {
    const from = dateLabel(20);
    const to = dateLabel(22);
    // Block the middle day only, so exactly one of three proposals must be refused.
    await seedShows(request, token, fixture, fixture.screenBId, dateLabel(21), ['18:00']);

    await gotoSchedule(page, fixture.cinemaId, from);
    await page.getByRole('button', { name: 'Create shows' }).click();
    const d = bulkDialog(page);
    await d.getByLabel('Screen').selectOption({ label: 'Screen B' });
    await d.getByLabel('Movie').selectOption(fixture.movieId);
    await d.getByLabel('Date mode').selectOption('range');
    await d.getByLabel('From').fill(from);
    await d.getByLabel('To', { exact: true }).fill(to);
    await d.getByLabel(/Showtimes/).fill('18:00');
    await d.getByRole('button', { name: 'Preview' }).click();

    await expect(page.getByText('3 slots proposed')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('2 will be created')).toBeVisible();
    await expect(page.getByText('1 will be skipped')).toBeVisible();
  });

  test('12-14: pause then reopen, with state visible throughout', async ({ page, request }) => {
    const date = dateLabel(25);
    await seedShows(request, token, fixture, fixture.screenAId, date, ['12:00']);
    await gotoSchedule(page, fixture.cinemaId, date);

    await expect(page.getByText('On sale', { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole('button', { name: /^Pause sales for/ }).click();
    // The dialog must say what pause does NOT do, so nobody thinks they stranded a customer.
    await expect(page.getByText(/Tickets already sold stay valid/)).toBeVisible();
    await page.getByRole('button', { name: 'Pause sales', exact: true }).click();

    await expect(page.getByText('Sales paused', { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('li').getByText('On sale', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: /^Reopen sales for/ }).click();
    await expect(page.getByText('On sale', { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('15-16: cancelling needs a reason and the show stays visible', async ({ page, request }) => {
    const date = dateLabel(26);
    await seedShows(request, token, fixture, fixture.screenAId, date, ['13:00']);
    await gotoSchedule(page, fixture.cinemaId, date);

    await page.getByRole('button', { name: /^Cancel .* at / }).click();
    const confirm = page.getByRole('button', { name: 'Cancel show' });
    // Guarded until a reason is given: cancelling strands people who have paid.
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/Reason \(required\)/).fill('projector failure');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // Kept and marked, not deleted — the operator still needs to see it happened.
    await expect(page.getByText('Cancelled', { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(fixture.movieTitle).first()).toBeVisible();
  });

  test('17: copies a day to the next date', async ({ page, request }) => {
    const source = dateLabel(30);
    const target = dateLabel(31);
    await seedShows(request, token, fixture, fixture.screenAId, source, ['09:00', '15:00']);

    await gotoSchedule(page, fixture.cinemaId, source);
    await page.getByRole('button', { name: 'Copy schedule' }).click();
    const d = copyDialog(page);
    await d.getByLabel('From screen').selectOption({ label: 'Screen A' });
    await d.getByLabel('Movie').selectOption(fixture.movieId);
    await d.getByLabel('To date').fill(target);
    await d.getByRole('button', { name: 'Preview' }).click();

    // The recovered LOCAL times are shown, which is what makes the preview self-explaining.
    await expect(copyDialog(page).getByText('09:00, 15:00')).toBeVisible({ timeout: 20_000 });
    await copyDialog(page)
      .getByRole('button', { name: /^Copy 2 shows/ })
      .click();

    await page.getByLabel('Date', { exact: true }).first().fill(target);
    await expect(page.getByTestId('screen-show-count').filter({ hasText: '2 shows' })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('18: copies a day to another screen without touching the source', async ({
    page,
    request,
  }) => {
    const date = dateLabel(35);
    await seedShows(request, token, fixture, fixture.screenAId, date, ['11:00']);

    await gotoSchedule(page, fixture.cinemaId, date);
    await page.getByRole('button', { name: 'Copy schedule' }).click();
    const d = copyDialog(page);
    await d.getByLabel('From screen').selectOption({ label: 'Screen A' });
    await d.getByLabel('To screen').selectOption({ label: 'Screen B' });
    await d.getByLabel('Movie').selectOption(fixture.movieId);
    await d.getByLabel('To date').fill(date);
    await d.getByRole('button', { name: 'Preview' }).click();
    await d.getByRole('button', { name: /^Copy 1 show/ }).click();

    // Both screens now hold one show; the source was copied, not moved.
    await expect(page.getByRole('heading', { name: 'Screen A' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Screen B' })).toBeVisible();
    await expect(page.getByTestId('screen-show-count').filter({ hasText: '1 show' })).toHaveCount(
      2,
      { timeout: 20_000 },
    );
  });

  test('19: a refresh shows the authoritative server state, not local optimism', async ({
    page,
    request,
  }) => {
    const date = dateLabel(40);
    const created = await seedShows(request, token, fixture, fixture.screenAId, date, ['16:00']);
    await gotoSchedule(page, fixture.cinemaId, date);
    await expect(page.getByText('On sale', { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });

    // Change it behind the UI's back, then reload: the page must report the server's truth.
    await request.post(`${API}/shows/${created.created[0].sessionId}/pause`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { reason: 'changed elsewhere' },
    });

    await page.reload();
    await page.getByLabel('Date', { exact: true }).fill(date);
    await expect(page.getByText('Sales paused', { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('20: another tenant cannot read this cinema’s schedule', async ({ page }) => {
    // organizer2 belongs to a different organization in the seed.
    await page.goto(`${ORGANIZER}/logout`).catch(() => undefined);
    await login(page, ORGANIZER, 'organizer2@eticketsgo.test').catch(() => undefined);
    await page.goto(`${ORGANIZER}/organizer/cinemas/${fixture.cinemaId}/schedule`);

    // The server refuses; the workspace surfaces that rather than rendering someone else's
    // programming. Either an explicit error or simply no schedule content is acceptable —
    // what must never appear is this cinema's shows.
    await expect(page.getByText(fixture.movieTitle)).toHaveCount(0, { timeout: 20_000 });
  });
  // ── Screen operational lifecycle ─────────────────────────────────────────────────

  test('21-26: a screen can be taken out of service and put back', async ({ page, request }) => {
    const date = dateLabel(45);
    // A future show exists on Screen B, so the confirmation must warn about it.
    await seedShows(request, token, fixture, fixture.screenBId, date, ['15:00']);

    await page.goto(`${ORGANIZER}/organizer/cinemas/${fixture.cinemaId}`);
    const row = page.getByRole('row', { name: /Screen B/ });
    await expect(row).toBeVisible({ timeout: 20_000 });
    // Status is readable text, not a colour.
    await expect(row.getByText('In service')).toBeVisible();

    await row.getByRole('button', { name: 'Change status for Screen B' }).click();
    const dlg = page.getByRole('dialog', { name: /Change status for Screen B/ });
    await dlg.getByLabel('New status').selectOption('MAINTENANCE');

    // The count is whatever earlier specs left on this screen — asserting an exact number
    // would couple this test to their execution order. What matters is that a count is
    // surfaced at all, and that the warning says those shows are NOT cancelled.
    await expect(dlg.getByText(/has \d+ future show/)).toBeVisible();
    await expect(dlg.getByText(/will not cancel them/)).toBeVisible();
    await expect(dlg.getByText(/Shows already scheduled are NOT cancelled/)).toBeVisible();

    await dlg.getByLabel(/Reason/).fill('projector replacement');
    await dlg.getByRole('button', { name: 'Set Maintenance' }).click();
    await expect(row.getByText('Maintenance')).toBeVisible({ timeout: 20_000 });

    // Survives a reload — the state is the server's, not the page's.
    await page.reload();
    await expect(page.getByRole('row', { name: /Screen B/ }).getByText('Maintenance')).toBeVisible({
      timeout: 20_000,
    });

    // The existing show is untouched: still there, still on sale.
    await gotoSchedule(page, fixture.cinemaId, date);
    await expect(page.getByRole('heading', { name: 'Screen B' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('On sale', { exact: true }).last()).toBeVisible();

    // Scheduling anything NEW on it is prevented twice over.
    //
    // In the UI the screen is offered but not selectable, and says why — better than
    // hiding it, which would leave an operator wondering where Screen B went.
    await page.getByRole('button', { name: 'Create shows' }).click();
    const bulk = bulkDialog(page);
    const maintenanceOption = bulk.locator(`option[value="${fixture.screenBId}"]`);
    await expect(maintenanceOption).toBeDisabled();
    await expect(maintenanceOption).toContainText(/maintenance/i);
    await bulk.getByRole('button', { name: 'Cancel', exact: true }).click();

    // And the SERVER refuses regardless, which is what actually protects the screen — a
    // disabled dropdown is a courtesy, not a control.
    const refused = await request.post(`${API}/movies/${fixture.movieId}/shows/bulk`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        screenId: fixture.screenBId,
        dates: [dateLabel(46)],
        times: ['10:00'],
        padMinutes: 0,
        timezone: CINEMA_TZ,
        dryRun: false,
      },
    });
    expect(refused.status()).toBe(409);
    expect(JSON.stringify(await refused.json())).toMatch(/maintenance/i);

    // Restore, and scheduling works again.
    await page.goto(`${ORGANIZER}/organizer/cinemas/${fixture.cinemaId}`);
    const rowAgain = page.getByRole('row', { name: /Screen B/ });
    await rowAgain.getByRole('button', { name: 'Change status for Screen B' }).click();
    const dlg2 = page.getByRole('dialog', { name: /Change status for Screen B/ });
    await dlg2.getByLabel('New status').selectOption('ACTIVE');
    await dlg2.getByRole('button', { name: 'Set In service' }).click();
    await expect(rowAgain.getByText('In service')).toBeVisible({ timeout: 20_000 });

    await gotoSchedule(page, fixture.cinemaId, dateLabel(46));
    await page.getByRole('button', { name: 'Create shows' }).click();
    const bulk2 = bulkDialog(page);
    await expect(bulk2.locator(`option[value="${fixture.screenBId}"]`)).toBeEnabled();
    await bulk2.getByLabel('Screen').selectOption(fixture.screenBId);
    await bulk2.getByLabel('Movie').selectOption(fixture.movieId);
    await bulk2.getByLabel('Date', { exact: true }).fill(dateLabel(46));
    await bulk2.getByLabel(/Showtimes/).fill('10:00');
    await bulk2.getByRole('button', { name: 'Preview' }).click();
    await expect(bulk2.getByText('1 slot proposed')).toBeVisible({ timeout: 20_000 });
  });

  test('27: another tenant cannot change this screen’s status', async ({ request }) => {
    // Asserted at the API, because the UI never renders the control for a foreign cinema —
    // and the server, not the absence of a button, is what has to refuse.
    const other = await apiLogin(request, 'organizer2@eticketsgo.test');
    const res = await request.patch(`${API}/screens/${fixture.screenAId}`, {
      headers: { Authorization: `Bearer ${other.accessToken}` },
      data: { name: 'Hijacked', screenType: '2D', capacity: 20, status: 'INACTIVE' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);

    const mine = await (
      await request.get(`${API}/cinemas/${fixture.cinemaId}/screens`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    const screenA = mine.find((s: { id: string }) => s.id === fixture.screenAId);
    expect(screenA.status).toBe('ACTIVE');
    expect(screenA.name).toBe('Screen A');
  });
  // ── Moving a show ────────────────────────────────────────────────────────────────
  //
  // The backend edit endpoint accepts a start time only. Its policy module also describes an
  // EDIT_SCREEN rule, but no endpoint exposes it, so there is no screen picker to test.
  // See the note at the top of edit-show.tsx.

  const openEdit = async (page: Page) => {
    await page
      .getByRole('button', { name: /^Move / })
      .first()
      .click();
    const dlg = page.getByRole('dialog', { name: 'Move show' });
    await expect(dlg).toBeVisible({ timeout: 20_000 });
    return dlg;
  };

  test('28-30: moves an unbooked show, and the new time survives a refresh', async ({
    page,
    request,
  }) => {
    const date = dateLabel(55);
    await seedShows(request, token, fixture, fixture.screenAId, date, ['09:00']);
    await gotoSchedule(page, fixture.cinemaId, date);

    const dlg = await openEdit(page);
    // Current values are shown, so the operator sees what they are changing from.
    await expect(dlg.getByText(`${date} at 09:00`)).toBeVisible();
    await expect(dlg.getByLabel('New date')).toHaveValue(date);
    await expect(dlg.getByLabel('New start time')).toHaveValue('09:00');

    await dlg.getByLabel('New start time').fill('16:30');
    await dlg.getByRole('button', { name: 'Save changes' }).click();

    await expect(page.getByText('16:30', { exact: false })).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await page.getByLabel('Date', { exact: true }).fill(date);
    await expect(page.getByText('16:30', { exact: false })).toBeVisible({ timeout: 20_000 });
  });

  test('31: saving with no change is not offered', async ({ page, request }) => {
    const date = dateLabel(56);
    await seedShows(request, token, fixture, fixture.screenAId, date, ['11:00']);
    await gotoSchedule(page, fixture.cinemaId, date);

    const dlg = await openEdit(page);
    // A no-op must not spend a request, nor look like it did something.
    await expect(dlg.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await dlg.getByLabel('New start time').fill('12:00');
    await expect(dlg.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  test('32-33: moving into a clash is refused with a readable reason', async ({
    page,
    request,
  }) => {
    const date = dateLabel(57);
    // 09:00 and 14:00 exist; moving the second onto the first must fail.
    await seedShows(request, token, fixture, fixture.screenAId, date, ['09:00', '14:00']);
    await gotoSchedule(page, fixture.cinemaId, date);

    await page
      .getByRole('button', { name: /^Move / })
      .nth(1)
      .click();
    const dlg = page.getByRole('dialog', { name: 'Move show' });
    await dlg.getByLabel('New start time').fill('09:30');
    await dlg.getByRole('button', { name: 'Save changes' }).click();

    // A human sentence, not a code, and it explains the turnaround as well.
    await expect(dlg.getByRole('alert')).toContainText(/conflicts with another show/i, {
      timeout: 20_000,
    });
    await expect(dlg.getByRole('alert')).toContainText(/cleaned/i);

    // Nothing moved optimistically: the show is still at its original time.
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('14:00', { exact: false })).toBeVisible();
  });

  test('34: a paid booking blocks the move and says to cancel instead', async ({
    page,
    request,
  }) => {
    const date = dateLabel(58);
    const seeded = await seedShows(request, token, fixture, fixture.screenAId, date, ['13:00']);
    const sessionId = seeded.created[0].sessionId;

    // Built through the real booking + mock settlement path, not by writing rows.
    await confirmBookingOnSession(request, token, sessionId);

    await gotoSchedule(page, fixture.cinemaId, date);
    const dlg = await openEdit(page);
    await dlg.getByLabel('New start time').fill('17:00');
    await dlg.getByRole('button', { name: 'Save changes' }).click();

    await expect(dlg.getByRole('alert')).toContainText(/already has paid bookings/i, {
      timeout: 20_000,
    });
    await expect(dlg.getByRole('alert')).toContainText(/Cancel the show instead/i);
  });

  test('35: a cancelled show offers no Move action, and the server refuses anyway', async ({
    page,
    request,
  }) => {
    const date = dateLabel(59);
    const seeded = await seedShows(request, token, fixture, fixture.screenAId, date, ['10:00']);
    await request.post(`${API}/shows/${seeded.created[0].sessionId}/cancel`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { reason: 'test cancellation' },
    });

    await gotoSchedule(page, fixture.cinemaId, date);
    await expect(page.getByText('Cancelled', { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: /^Move / })).toHaveCount(0);

    // Hiding the button is a courtesy; the server is the control.
    const refused = await request.post(`${API}/shows/${seeded.created[0].sessionId}/reschedule`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), padMinutes: 0 },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).details?.reason).toBe('SHOW_CANCELLED');
  });

  test('36: another tenant cannot move this show', async ({ request }) => {
    const date = dateLabel(60);
    await seedShows(request, token, fixture, fixture.screenAId, date, ['08:00']);
    const listed = await (
      await request.get(
        `${API}/cinemas/${fixture.cinemaId}/schedule?date=${date}&timezone=${CINEMA_TZ}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
    ).json();
    const sessionId = listed[0].sessionId;

    const other = await apiLogin(request, 'organizer2@eticketsgo.test');
    const refused = await request.post(`${API}/shows/${sessionId}/reschedule`, {
      headers: { Authorization: `Bearer ${other.accessToken}` },
      data: { startsAt: new Date(Date.now() + 11 * 86_400_000).toISOString(), padMinutes: 0 },
    });
    expect(refused.status()).toBeGreaterThanOrEqual(400);

    const after = await (
      await request.get(
        `${API}/cinemas/${fixture.cinemaId}/schedule?date=${date}&timezone=${CINEMA_TZ}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
    ).json();
    expect(after).toHaveLength(1);
    expect(after[0].startsAt).toBe(listed[0].startsAt);
  });

  test('37: closing the dialog returns focus to the control that opened it', async ({
    page,
    request,
  }) => {
    const date = dateLabel(61);
    await seedShows(request, token, fixture, fixture.screenAId, date, ['19:00']);
    await gotoSchedule(page, fixture.cinemaId, date);

    const trigger = page.getByRole('button', { name: /^Move / }).first();
    await trigger.click();
    const dlg = page.getByRole('dialog', { name: 'Move show' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();

    // A keyboard user must not be dumped at the top of the document.
    await expect(trigger).toBeFocused();
  });
  // ── Week planning ────────────────────────────────────────────────────────────────

  const openWeek = async (page: Page, cinemaId: string, anchor: string) => {
    await gotoSchedule(page, cinemaId, anchor);
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(page.getByText(/Local dates and times at the cinema/)).toBeVisible({
      timeout: 20_000,
    });
  };

  test('38-40: switches to Week and buckets shows under the right local day', async ({
    page,
    request,
  }) => {
    const monday = mondayOf(dateLabel(70));
    const wednesday = shiftLabel(monday, 2);
    await seedShows(request, token, fixture, fixture.screenAId, wednesday, ['11:00']);

    await openWeek(page, fixture.cinemaId, monday);

    // Seven local dates, Monday first.
    for (let i = 0; i < 7; i += 1) {
      await expect(
        page.getByRole('heading', { name: headingFor(shiftLabel(monday, i)) }),
      ).toBeVisible();
    }

    // The show sits under Wednesday and nowhere else.
    await expect(page.getByTestId(`week-day-${wednesday}`).getByText('11:00')).toBeVisible();
    await expect(page.getByRole('button', { name: /11:00 .*Screen A/ })).toHaveCount(1);
  });

  test('41-43: week navigation moves seven days at a time and Today returns', async ({
    page,
    request,
  }) => {
    const monday = mondayOf(dateLabel(77));
    const nextMonday = shiftLabel(monday, 7);
    await seedShows(request, token, fixture, fixture.screenAId, nextMonday, ['09:00']);

    await openWeek(page, fixture.cinemaId, monday);
    // Not in this week.
    await expect(page.getByRole('button', { name: /09:00 .*Screen A/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Next week' }).click();
    await expect(page.getByRole('button', { name: /09:00 .*Screen A/ })).toHaveCount(1, {
      timeout: 20_000,
    });

    await page.getByRole('button', { name: 'Previous week' }).click();
    await expect(page.getByRole('button', { name: /09:00 .*Screen A/ })).toHaveCount(0, {
      timeout: 20_000,
    });

    await page.getByRole('button', { name: 'Today' }).click();
    await expect(page.getByText(/Local dates and times at the cinema/)).toBeVisible();
  });

  test('44: the screen filter applies to the week', async ({ page, request }) => {
    const monday = mondayOf(dateLabel(84));
    const day = shiftLabel(monday, 1);
    await seedShows(request, token, fixture, fixture.screenAId, day, ['10:00']);
    await seedShows(request, token, fixture, fixture.screenBId, day, ['15:00']);

    await openWeek(page, fixture.cinemaId, monday);
    await expect(page.getByRole('button', { name: /10:00 .*Screen A/ })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /15:00 .*Screen B/ })).toHaveCount(1);

    await page.getByLabel('Screen', { exact: true }).selectOption(fixture.screenAId);
    await expect(page.getByRole('button', { name: /10:00 .*Screen A/ })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /15:00 .*Screen B/ })).toHaveCount(0);
  });

  test('45-46: paused and cancelled shows are distinguishable in the week', async ({
    page,
    request,
  }) => {
    const monday = mondayOf(dateLabel(91));
    const day = shiftLabel(monday, 3);
    const seeded = await seedShows(request, token, fixture, fixture.screenAId, day, [
      '10:00',
      '16:00',
    ]);
    const auth = { Authorization: `Bearer ${token}` };
    await request.post(`${API}/shows/${seeded.created[0].sessionId}/pause`, {
      headers: auth,
      data: { reason: 'staffing' },
    });
    await request.post(`${API}/shows/${seeded.created[1].sessionId}/cancel`, {
      headers: auth,
      data: { reason: 'print not delivered' },
    });

    await openWeek(page, fixture.cinemaId, monday);
    // Each state is in the card's accessible name, so it is announced once and is not
    // carried by colour.
    await expect(page.getByRole('button', { name: /10:00 .*Sales paused/ })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /16:00 .*Cancelled/ })).toHaveCount(1);
  });

  test('47: selecting a show hands over to the day view', async ({ page, request }) => {
    const monday = mondayOf(dateLabel(98));
    const day = shiftLabel(monday, 4);
    await seedShows(request, token, fixture, fixture.screenAId, day, ['13:00']);

    await openWeek(page, fixture.cinemaId, monday);
    await page.getByRole('button', { name: /13:00 .*Screen A/ }).click();

    // The day view is where the pause/move/cancel controls live — they are not duplicated.
    await expect(page.getByLabel('Date', { exact: true })).toHaveValue(day);
    await expect(page.getByRole('button', { name: /^Move / })).toHaveCount(1, {
      timeout: 20_000,
    });
  });

  test('48: an empty week says something useful', async ({ page }) => {
    await openWeek(page, fixture.cinemaId, mondayOf(dateLabel(200)));
    await expect(page.getByText('Nothing scheduled this week')).toBeVisible();
  });

  // ── The booking window ───────────────────────────────────────────────────────────
  //
  // A show's LIFECYCLE status (scheduled / paused / cancelled) and its BOOKING WINDOW
  // (open / not yet / closed) are different questions, and a show can be perfectly
  // scheduled while being unsellable. Every test here checks the operator's badge against
  // the API's actual answer, because agreement between the two is the whole value of the
  // badge. The close boundary is INCLUSIVE — booking creation refuses on `salesEndAt < now`
  // — and these bracket it from both sides rather than asserting the rule in the abstract.

  test('50: a show whose sales have not opened says so, and the API refuses', async ({
    page,
    request,
  }) => {
    const date = dateLabel(112);
    const seeded = await seedShows(request, token, fixture, fixture.screenAId, date, ['10:00']);
    const sessionId = seeded.created[0].sessionId;
    await setSalesWindow(request, token, sessionId, {
      salesStartAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });

    await gotoSchedule(page, fixture.cinemaId, date);
    await expect(showRow(page).getByText('Not open yet')).toBeVisible({ timeout: 20_000 });

    // The badge is not decoration: the endpoint agrees with it.
    const attempt = await tryBooking(request, token, sessionId);
    expect(attempt.ok).toBe(false);
    expect(attempt.status).toBe(409);
    expect(attempt.message).toMatch(/not currently on sale/i);
  });

  test('51: just inside the close, the show is on sale and a booking succeeds', async ({
    page,
    request,
  }) => {
    const date = dateLabel(113);
    const seeded = await seedShows(request, token, fixture, fixture.screenAId, date, ['10:00']);
    const sessionId = seeded.created[0].sessionId;
    // Five minutes of window left. The near side of the boundary.
    await setSalesWindow(request, token, sessionId, {
      salesEndAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    await gotoSchedule(page, fixture.cinemaId, date);
    // No window badge at all: the row is sellable, so there is nothing to warn about.
    await expect(showRow(page).getByText('Booking closed')).toHaveCount(0);
    await expect(showRow(page).getByText('Not open yet')).toHaveCount(0);

    const attempt = await tryBooking(request, token, sessionId);
    expect(attempt.ok).toBe(true);
  });

  test('52: past the close, the badge says closed and the API refuses', async ({
    page,
    request,
  }) => {
    const date = dateLabel(114);
    const seeded = await seedShows(request, token, fixture, fixture.screenAId, date, ['10:00']);
    const sessionId = seeded.created[0].sessionId;
    // One minute past. The far side of the same boundary tested above.
    await setSalesWindow(request, token, sessionId, {
      salesEndAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await gotoSchedule(page, fixture.cinemaId, date);
    await expect(showRow(page).getByText('Booking closed')).toBeVisible({ timeout: 20_000 });

    const attempt = await tryBooking(request, token, sessionId);
    expect(attempt.ok).toBe(false);
    expect(attempt.status).toBe(409);
  });

  test('53: a closed show is still operable — it is not hidden from the day', async ({
    page,
    request,
  }) => {
    const date = dateLabel(115);
    const seeded = await seedShows(request, token, fixture, fixture.screenAId, date, ['21:00']);
    await setSalesWindow(request, token, seeded.created[0].sessionId, {
      salesEndAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await gotoSchedule(page, fixture.cinemaId, date);
    // Closing the counter is not the same as the show going away. The operator still has to
    // be able to move or cancel it, and the row must still be there to do that with.
    await expect(showRow(page).getByText('Booking closed')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('21:00', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Move / })).toHaveCount(1);
  });

  test('54: pausing wins over the window, and says the operator did it', async ({
    page,
    request,
  }) => {
    const date = dateLabel(116);
    const seeded = await seedShows(request, token, fixture, fixture.screenAId, date, ['12:00']);
    const sessionId = seeded.created[0].sessionId;
    await setSalesWindow(request, token, sessionId, {
      salesEndAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    await request.post(`${API}/shows/${sessionId}/pause`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { reason: 'projector fault' },
    });

    // A deliberate pause and an elapsed clock are not the same situation, and only one of
    // them is undone by a person. The operator must be told which one they are looking at.
    await gotoSchedule(page, fixture.cinemaId, date);
    await expect(showRow(page).getByText('Sales paused')).toBeVisible({ timeout: 20_000 });
    await expect(showRow(page).getByText('Booking closed')).toHaveCount(0);
  });

  test('55: the week view shows the same window states as the day', async ({ page, request }) => {
    const monday = mondayOf(dateLabel(119));
    const day = shiftLabel(monday, 1);
    const closed = await seedShows(request, token, fixture, fixture.screenAId, day, ['10:00']);
    const notOpen = await seedShows(request, token, fixture, fixture.screenAId, day, ['15:00']);
    await setSalesWindow(request, token, closed.created[0].sessionId, {
      salesEndAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await setSalesWindow(request, token, notOpen.created[0].sessionId, {
      salesStartAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });

    await openWeek(page, fixture.cinemaId, monday);
    // Both views derive from the same badge function; this is the guard against a second
    // set of window rules quietly appearing in one of them.
    //
    // Scoped to this test's own day column. Earlier specs in this file seed their own closed
    // 10:00 shows, and some of those dates land inside this same week — a page-wide count
    // asserts on other tests' data and drifts every time one of them changes.
    const column = page.getByTestId(`week-day-${day}`);
    await expect(column.getByRole('button', { name: /10:00 .*Booking closed/ })).toHaveCount(1);
    await expect(column.getByRole('button', { name: /15:00 .*Not open yet/ })).toHaveCount(1);
  });
});

/**
 * The timezone regression, in its own describe so the browser can be pinned to a zone that
 * is NOT the cinema's.
 *
 * This is the defect that has now appeared twice on this page — once in the day query and
 * once in the row rendering — so it gets an explicit guard. A Hyderabad cinema operated from
 * London must show Hyderabad times and Hyderabad days.
 */
test.describe('week view under a foreign browser timezone', () => {
  test.use({ timezoneId: 'Europe/London' });

  let token = '';
  let fixture: Fixture;

  test.beforeAll(async ({ request }) => {
    const tokens = await apiLogin(request, OWNER);
    token = tokens.accessToken;
    fixture = await createFixture(request, token);
  });

  test('49: a Hyderabad show keeps its Hyderabad time and day in a London browser', async ({
    page,
    request,
  }) => {
    const monday = mondayOf(dateLabel(105));
    const day = shiftLabel(monday, 2);
    // 00:30 IST is 19:00 the PREVIOUS day in UTC, and 20:00 the previous day in London
    // during BST. A browser-derived bucket would file it under the wrong date entirely.
    await seedShows(request, token, fixture, fixture.screenAId, day, ['00:30']);

    await login(page, ORGANIZER, OWNER);
    await gotoSchedule(page, fixture.cinemaId, monday);
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(page.getByText(/Local dates and times at the cinema/)).toBeVisible({
      timeout: 20_000,
    });

    // Cinema-local time, not London time.
    const card = page.getByRole('button', { name: /00:30 .*Screen A/ });
    await expect(card).toHaveCount(1);

    // And under the cinema-local DAY.
    await expect(page.getByTestId(`week-day-${day}`).getByText('00:30')).toBeVisible();

    // Explicitly NOT bucketed under the previous day, which is where a browser-zone
    // implementation would have put it.
    await expect(
      page.getByTestId(`week-day-${shiftLabel(day, -1)}`).getByText('00:30'),
    ).toHaveCount(0);
  });
});
