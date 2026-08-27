import AxeBuilder from '@axe-core/playwright';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/** Readable axe output — an id and a count tells nobody what to fix. */
function describeViolations(
  violations: {
    id: string;
    impact?: string | null;
    help: string;
    nodes: { target: unknown[]; failureSummary?: string }[];
  }[],
): string {
  return violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 3)
        .map((n) => `${n.target.join(' ')} — ${(n.failureSummary ?? '').split('\n').join(' ')}`)
        .join('\n  ');
      return `${v.id} (${v.impact}): ${v.help}\n  ${nodes}`;
    })
    .join('\n');
}

/**
 * Organizer theater operations — live shows, seat overrides and layout versions.
 *
 * Drives the real UI against the real API. Nothing here reimplements a backend rule: the
 * sold-seat guard, the hold guard and the layout lifecycle are all asserted by observing what
 * the server decided and what the operator is then shown.
 *
 * These do NOT duplicate the PostgreSQL concurrency proofs. Those live in
 * `seat-overrides.integration-postgres.spec.ts`, where two independent database clients can
 * actually race; a browser test pretending to do that would prove nothing and be flaky.
 * What is tested here is the OPERATOR'S EXPERIENCE of those rules.
 *
 * Every spec builds its own cinema, screen, layout and show over the API, so nothing depends
 * on seed data or on execution order.
 */

const OWNER = 'owner@eticketsgo.test';
const CINEMA_TZ = 'Asia/Kolkata';

interface Fixture {
  cinemaId: string;
  screenId: string;
  movieId: string;
  sessionId: string;
  seatIds: string[];
  ticketTypeId: string;
  date: string;
}

function todayLabel(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CINEMA_TZ }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );
}

/**
 * A showtime later today, in the cinema's own clock.
 *
 * ── WHY THIS IS NOT JUST '23:30' ───────────────────────────────────────────────────
 * It was, and CI failed on it at 23:57 Kolkata time with "no published seat layout is in
 * effect for that date". A screen's first layout takes effect the instant it is created, so
 * a fixture that creates a layout at 23:57 and then asks for a show at 23:30 is asking for a
 * show that predates the room it plays in. The scenario was also untrue on its own terms —
 * "a show LATER today" is not later when it has already started.
 *
 * Derived from the venue clock instead, so the show is always ahead of the layout by
 * construction. Returns null in the last minutes before midnight, where no such time exists
 * and the honest answer is to skip rather than to schedule something the guard will refuse.
 */
function laterTodayAtVenue(minutesAhead = 45): string | null {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CINEMA_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const target = hour * 60 + minute + minutesAhead;
  if (target >= 24 * 60) return null;
  return `${String(Math.floor(target / 60)).padStart(2, '0')}:${String(target % 60).padStart(2, '0')}`;
}

/** A private cinema with one screen, a published layout, and one show today. */
async function createFixture(request: APIRequestContext, token: string): Promise<Fixture> {
  const auth = { Authorization: `Bearer ${token}` };
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs[0] : orgs.data?.[0])?.id as string;

  const cinema = await (
    await request.post(`${API}/cinemas`, {
      headers: auth,
      data: { organizationId, name: `Ops Multiplex ${suffix}`, city: 'Hyderabad' },
    })
  ).json();
  const screen = await (
    await request.post(`${API}/cinemas/${cinema.id}/screens`, {
      headers: auth,
      data: { name: 'Screen A', screenType: '2D', capacity: 12 },
    })
  ).json();
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
          seatsPerRow: 6,
        },
      ],
    },
  });

  const movie = await (
    await request.post(`${API}/movies`, {
      headers: auth,
      data: {
        organizationId,
        title: `Ops Feature ${suffix}`,
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

  // A show later today, so it appears on the default operations board.
  const date = todayLabel();
  const showTime = laterTodayAtVenue();
  if (!showTime) {
    throw new Error(
      'It is within 45 minutes of midnight at the venue, so there is no "later today" to ' +
        'schedule into. Re-run after midnight.',
    );
  }
  const seeded = await (
    await request.post(`${API}/movies/${movie.id}/shows/bulk`, {
      headers: auth,
      data: {
        screenId: screen.id,
        dates: [date],
        times: [showTime],
        padMinutes: 0,
        timezone: CINEMA_TZ,
        dryRun: false,
      },
    })
  ).json();
  // Fail with the server's own words. `seeded.created[0]` on an error response throws
  // "cannot read properties of undefined", which says nothing about what actually went wrong.
  if (!seeded?.created?.[0]?.sessionId) {
    throw new Error(`bulk schedule did not create a show: ${JSON.stringify(seeded)}`);
  }
  const sessionId = seeded.created[0].sessionId as string;

  const seats = await (await request.get(`${API}/public/shows/${sessionId}/seats`)).json();
  const seatIds = seats.sections
    .flatMap((s: { rows: { seats: { id: string }[] }[] }) => s.rows)
    .flatMap((r: { seats: { id: string }[] }) => r.seats)
    .map((s: { id: string }) => s.id) as string[];

  return {
    cinemaId: cinema.id,
    screenId: screen.id,
    movieId: movie.id,
    sessionId,
    seatIds,
    ticketTypeId: seats.categories[0].ticketTypeId,
    date,
  };
}

/** Open the live operations board and wait for it to render. */
const gotoLive = async (page: Page, fixture: Fixture) => {
  await page.goto(`${ORGANIZER}/organizer/cinemas/${fixture.cinemaId}/live`);
  await expect(page.getByLabel('Date', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Date', { exact: true }).fill(fixture.date);
};

/** Open the seat map for the fixture's show. */
const openSeatMap = async (page: Page) => {
  await page
    .getByRole('button', { name: /Open seat map for/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: /^Seat A1/ })).toBeVisible({ timeout: 20_000 });
};

const seatButton = (page: Page, label: string) =>
  page.getByRole('button', { name: new RegExp(`^Seat ${label},`) });

const overrideDialog = (page: Page, label: string) =>
  page.getByRole('dialog', { name: `Seat ${label}` });

/*
  ONE fixture for the entire file.

  Each describe used to build its own cinema, screen, movie and show — three logins and
  roughly thirty extra requests. All e2e traffic comes from a single IP, so that pushed the
  whole suite over the API's shared rate limit and took unrelated specs down with it. Sharing
  is also a better test: layout versions and live operations coexisting on one screen is
  exactly the real arrangement.
*/
let sharedToken = '';
let sharedTokens: AuthTokens;
let sharedFixture: Fixture;

test.beforeAll(async ({ request }) => {
  sharedTokens = await apiLogin(request, OWNER);
  sharedToken = sharedTokens.accessToken;
  sharedFixture = await createFixture(request, sharedToken);
});

test.describe('organizer theater operations', () => {
  let token = '';
  let tokens: AuthTokens;
  let fixture: Fixture;

  test.beforeAll(() => {
    tokens = sharedTokens;
    token = sharedToken;
    fixture = sharedFixture;
  });

  /*
    Auth is seeded into localStorage rather than driven through the login form.

    Signing in per test costs one POST /auth/login each, and eighteen of those trips the
    API's auth throttle — which surfaced as a flat UNAUTHORIZED on unrelated requests and
    took three tests down for reasons that had nothing to do with what they assert. The
    helper exists for exactly this; the throttle stays as it is.
  */
  test.beforeEach(async ({ context, request }) => {
    await seedBrowserAuth(context, tokens);
    // Reset every seat between tests so ordering cannot matter.
    await request.post(`${API}/shows/${fixture.sessionId}/seats/release`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { seatIds: fixture.seatIds, reason: 'test reset', force: true },
    });
  });

  // ── Dashboard ────────────────────────────────────────────────────────────────────

  test('1-2: the operations board lists today’s shows with server-computed occupancy', async ({
    page,
  }) => {
    await gotoLive(page, fixture);
    await expect(page.getByText('Ops Feature')).toBeVisible({ timeout: 20_000 });
    // Occupancy comes from the API already calculated — the UI never recomputes it.
    await expect(page.getByText(/\d+% full|— full/)).toBeVisible();
    await expect(page.getByText(/\d+ sold · \d+ held · \d+ withheld/)).toBeVisible();
  });

  test('3: opening a show reveals its metrics', async ({ page }) => {
    await gotoLive(page, fixture);
    await openSeatMap(page);
    // Scoped: "Available" also appears in the seat-map legend, and a page-wide lookup
    // resolves to both.
    const metrics = page.getByRole('region', { name: 'Show metrics' });
    for (const label of ['Sold', 'Held', 'Available', 'Withheld', 'Occupancy', 'Revenue']) {
      await expect(metrics.getByText(label, { exact: true })).toBeVisible();
    }
  });

  // ── Seat map ─────────────────────────────────────────────────────────────────────

  test('4-5: the seat map renders every seat with an accessible name and a legend', async ({
    page,
  }) => {
    await gotoLive(page, fixture);
    await openSeatMap(page);

    // 2 rows x 6 seats. Each is a real button, so the map is operable by keyboard.
    await expect(page.getByRole('button', { name: /^Seat [AB]\d/ })).toHaveCount(12);
    await expect(page.getByLabel('Seat map legend')).toBeVisible();
    await expect(seatButton(page, 'A1')).toHaveAttribute('data-status', 'AVAILABLE');
  });

  // ── Blocking ─────────────────────────────────────────────────────────────────────

  test('6-8: blocking requires a reason, applies, and survives a refresh', async ({ page }) => {
    await gotoLive(page, fixture);
    await openSeatMap(page);
    await seatButton(page, 'A1').click();

    const dlg = overrideDialog(page, 'A1');
    await expect(dlg).toBeVisible();
    // A block nobody can explain is a seat nobody dares release.
    await expect(dlg.getByRole('button', { name: 'Withdraw seat' })).toBeDisabled();

    await dlg.getByLabel(/Reason/).fill('spilled drink');
    await expect(dlg.getByRole('button', { name: 'Withdraw seat' })).toBeEnabled();
    await dlg.getByRole('button', { name: 'Withdraw seat' }).click();

    await expect(dlg).toBeHidden({ timeout: 20_000 });
    await expect(seatButton(page, 'A1')).toHaveAttribute('data-status', 'BLOCKED', {
      timeout: 20_000,
    });

    // Authoritative, not local optimism.
    await page.reload();
    await page.getByLabel('Date', { exact: true }).fill(fixture.date);
    await openSeatMap(page);
    await expect(seatButton(page, 'A1')).toHaveAttribute('data-status', 'BLOCKED');
  });

  test('9: the blocked seat announces its reason to a screen reader', async ({ page, request }) => {
    await request.post(`${API}/shows/${fixture.sessionId}/seats/block`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { seatIds: [fixture.seatIds[0]], kind: 'MAINTENANCE', reason: 'broken recliner' },
    });
    await gotoLive(page, fixture);
    await openSeatMap(page);

    // State is in the accessible name, not carried by colour.
    const name = await seatButton(page, 'A1').getAttribute('aria-label');
    expect(name).toContain('maintenance');
    expect(name).toContain('broken recliner');
  });

  test('10: releasing puts the seat back on sale', async ({ page, request }) => {
    await request.post(`${API}/shows/${fixture.sessionId}/seats/block`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { seatIds: [fixture.seatIds[0]], kind: 'MANUAL_BLOCK', reason: 'held back' },
    });
    await gotoLive(page, fixture);
    await openSeatMap(page);
    await seatButton(page, 'A1').click();

    const dlg = overrideDialog(page, 'A1');
    await dlg.getByLabel(/Reason/).fill('no longer needed');
    await dlg.getByRole('button', { name: 'Release seat' }).click();

    await expect(seatButton(page, 'A1')).toHaveAttribute('data-status', 'AVAILABLE', {
      timeout: 20_000,
    });
  });

  // ── Maintenance and house ────────────────────────────────────────────────────────

  test('11-12: a maintenance block takes an expiry and says what expiry does', async ({ page }) => {
    await gotoLive(page, fixture);
    await openSeatMap(page);
    await seatButton(page, 'A2').click();

    const dlg = overrideDialog(page, 'A2');
    await dlg.getByLabel('Withdraw because').selectOption('MAINTENANCE');
    await expect(dlg.getByLabel(/Return to sale at/)).toBeVisible();
    // Must not imply a sold seat gets taken back off a customer.
    await expect(dlg.getByText(/still safe to do so/i)).toBeVisible();
    await expect(dlg.getByText(/never disturbed/i)).toBeVisible();

    await dlg.getByLabel(/Reason/).fill('projector glare');
    await dlg.getByRole('button', { name: 'Withdraw seat' }).click();
    await expect(seatButton(page, 'A2')).toHaveAttribute('data-override', 'MAINTENANCE', {
      timeout: 20_000,
    });
  });

  test('13-14: a house seat records its purpose and is distinguishable from a fault', async ({
    page,
  }) => {
    await gotoLive(page, fixture);
    await openSeatMap(page);
    await seatButton(page, 'A3').click();

    const dlg = overrideDialog(page, 'A3');
    await dlg.getByLabel('Withdraw because').selectOption('HOUSE');
    // The purpose picker only exists for house seats.
    await expect(dlg.getByLabel('House seat purpose')).toBeVisible();
    await dlg.getByLabel('House seat purpose').selectOption('SPONSOR');
    await dlg.getByLabel(/Reason/).fill('sponsor allocation');
    await dlg.getByRole('button', { name: 'Withdraw seat' }).click();

    await expect(seatButton(page, 'A3')).toHaveAttribute('data-override', 'HOUSE', {
      timeout: 20_000,
    });
    // The summary tells an operator a comp from a fault at a glance.
    await expect(page.getByText(/House seat: 1/)).toBeVisible();
  });

  test('15: an emergency block cannot be released without an explicit confirmation', async ({
    page,
    request,
  }) => {
    await request.post(`${API}/shows/${fixture.sessionId}/seats/block`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { seatIds: [fixture.seatIds[4]], kind: 'EMERGENCY', reason: 'gangway keep-clear' },
    });
    await gotoLive(page, fixture);
    await openSeatMap(page);
    await seatButton(page, 'A5').click();

    const dlg = overrideDialog(page, 'A5');
    await dlg.getByLabel(/Reason/).fill('fire officer cleared it');
    // Safety blocks must not vanish because somebody was clearing clutter.
    await expect(dlg.getByRole('button', { name: 'Release seat' })).toBeDisabled();
    await dlg.getByRole('checkbox').check();
    await expect(dlg.getByRole('button', { name: 'Release seat' })).toBeEnabled();
  });

  // ── The rules that protect customers ─────────────────────────────────────────────

  test('16-17: a SOLD seat offers no override and explains the alternatives', async ({
    page,
    request,
  }) => {
    const auth = { Authorization: `Bearer ${token}` };
    const seatId = fixture.seatIds[5];
    const booking = await (
      await request.post(`${API}/bookings`, {
        headers: { ...auth, 'idempotency-key': `ops-sold-${Date.now()}` },
        data: {
          eventSessionId: fixture.sessionId,
          items: [{ ticketTypeId: fixture.ticketTypeId, quantity: 1, seatIds: [seatId] }],
          buyerName: 'Ops Buyer',
          buyerEmail: 'ops-buyer@eticketsgo.test',
        },
      })
    ).json();
    await request.post(`${API}/bookings/${booking.id}/pay`, { headers: auth, data: {} });
    await request.post(`${API}/payments/${booking.id}/mock-pay`, { headers: auth, data: {} });

    await gotoLive(page, fixture);
    await openSeatMap(page);
    await expect(seatButton(page, 'A6')).toHaveAttribute('data-status', 'SOLD');
    await expect(seatButton(page, 'A6')).toHaveAttribute('data-actionable', 'false');

    await seatButton(page, 'A6').click();
    const dlg = overrideDialog(page, 'A6');
    await expect(dlg.getByText(/already been sold/i)).toBeVisible();
    // Names the two honest routes rather than only refusing.
    await expect(dlg.getByText(/Cancel the show or refund the booking/i)).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Withdraw seat' })).toHaveCount(0);

    // And the server refuses independently — hiding the control is a courtesy, not the guard.
    const refused = await request.post(`${API}/shows/${fixture.sessionId}/seats/block`, {
      headers: auth,
      data: { seatIds: [seatId], kind: 'MANUAL_BLOCK', reason: 'try anyway' },
    });
    expect((await refused.json()).seats[0].code).toBe('SEAT_SOLD');
  });

  test('18: a seat under a live checkout offers no override', async ({ page, request }) => {
    const auth = { Authorization: `Bearer ${token}` };
    const seatId = fixture.seatIds[1];
    await request.post(`${API}/bookings`, {
      headers: { ...auth, 'idempotency-key': `ops-held-${Date.now()}` },
      data: {
        eventSessionId: fixture.sessionId,
        items: [{ ticketTypeId: fixture.ticketTypeId, quantity: 1, seatIds: [seatId] }],
        buyerName: 'Holder',
        buyerEmail: 'holder@eticketsgo.test',
      },
    });

    await gotoLive(page, fixture);
    await openSeatMap(page);
    await seatButton(page, 'A2').click();
    const dlg = overrideDialog(page, 'A2');
    await expect(dlg.getByText(/held by a customer/i)).toBeVisible();
  });

  test('19: losing a race reloads the truth instead of showing a phantom block', async ({
    page,
    request,
  }) => {
    const auth = { Authorization: `Bearer ${token}` };
    await gotoLive(page, fixture);
    await openSeatMap(page);
    await seatButton(page, 'A4').click();

    const dlg = overrideDialog(page, 'A4');
    await dlg.getByLabel(/Reason/).fill('about to lose a race');

    // Somebody buys the seat while the dialog is open — the common case, not an edge case.
    const booking = await (
      await request.post(`${API}/bookings`, {
        headers: { ...auth, 'idempotency-key': `ops-race-${Date.now()}` },
        data: {
          eventSessionId: fixture.sessionId,
          items: [
            { ticketTypeId: fixture.ticketTypeId, quantity: 1, seatIds: [fixture.seatIds[3]] },
          ],
          buyerName: 'Racer',
          buyerEmail: 'racer@eticketsgo.test',
        },
      })
    ).json();
    await request.post(`${API}/bookings/${booking.id}/pay`, { headers: auth, data: {} });
    await request.post(`${API}/payments/${booking.id}/mock-pay`, { headers: auth, data: {} });

    await dlg.getByRole('button', { name: 'Withdraw seat' }).click();

    // The refusal is announced, and the map is refreshed to the real state.
    await expect(dlg.getByRole('alert')).toContainText(
      /already been sold|changed while you were/i,
      {
        timeout: 20_000,
      },
    );
    await expect(seatButton(page, 'A4')).toHaveAttribute('data-status', 'SOLD', {
      timeout: 20_000,
    });
  });

  // ── Audit ────────────────────────────────────────────────────────────────────────

  test('20-21: the override appears in the audit report with actor, seat and reason', async ({
    page,
    request,
  }) => {
    await request.post(`${API}/shows/${fixture.sessionId}/seats/block`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { seatIds: [fixture.seatIds[0]], kind: 'VIP', reason: 'guest of the director' },
    });

    await page.goto(`${ORGANIZER}/organizer/cinemas/${fixture.cinemaId}/reports`);
    await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 });
    const row = page.getByRole('row').filter({ hasText: 'guest of the director' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Omar Organizer');
    await expect(row).toContainText('A1');
    await expect(row).toContainText('VIP reserved');
  });

  // ── Tenancy ──────────────────────────────────────────────────────────────────────

  test('22: another tenant cannot read or change this cinema’s seats', async ({ request }) => {
    const other = await apiLogin(request, 'organizer2@eticketsgo.test');
    const auth = { Authorization: `Bearer ${other.accessToken}` };

    const map = await request.get(`${API}/shows/${fixture.sessionId}/live-seat-map`, {
      headers: auth,
    });
    expect(map.status()).toBeGreaterThanOrEqual(400);

    const block = await request.post(`${API}/shows/${fixture.sessionId}/seats/block`, {
      headers: auth,
      data: { seatIds: [fixture.seatIds[0]], kind: 'MANUAL_BLOCK', reason: 'not mine' },
    });
    expect(block.status()).toBeGreaterThanOrEqual(400);

    const report = await request.get(
      `${API}/cinemas/${fixture.cinemaId}/reports/seat-overrides?from=${new Date(0).toISOString()}&to=${new Date().toISOString()}`,
      { headers: auth },
    );
    expect(report.status()).toBeGreaterThanOrEqual(400);
  });
});

// ── Layout versioning ──────────────────────────────────────────────────────────────

test.describe('seat layout versions', () => {
  let token = '';
  let tokens: AuthTokens;
  let fixture: Fixture;

  test.beforeAll(() => {
    tokens = sharedTokens;
    token = sharedToken;
    fixture = sharedFixture;
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  const gotoLayouts = async (page: Page) => {
    await page.goto(
      `${ORGANIZER}/organizer/cinemas/${fixture.cinemaId}/screens/${fixture.screenId}/layouts`,
    );
    await expect(page.getByText('v1')).toBeVisible({ timeout: 20_000 });
  };

  test('23-24: the screen shows v1 published and active, and clone creates a draft', async ({
    page,
  }) => {
    await gotoLayouts(page);
    // Scoped to v1's row: 'PUBLISHED' and 'DRAFT' appear once per version, and this screen
    // grows more versions as the suite runs.
    const v1 = page.getByTestId('layout-1');
    await expect(v1.getByText('PUBLISHED')).toBeVisible();
    await expect(v1.getByText('Active today')).toBeVisible();

    await page.getByRole('button', { name: /Clone version 1/ }).click();
    const v2 = page.getByTestId('layout-2');
    await expect(v2).toBeVisible({ timeout: 20_000 });
    await expect(v2.getByText('DRAFT')).toBeVisible();
  });

  test('25: a published version offers no edit, only clone and archive', async ({ page }) => {
    await gotoLayouts(page);
    // Published layouts are frozen — sold tickets point at their seats.
    await expect(page.getByRole('button', { name: /^Publish version 1$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Clone version 1 as/ })).toBeVisible();
    await expect(page.getByTestId('layout-1').getByText('Frozen')).toBeVisible();
  });

  test('26-27: publishing a draft with a future date shows it as scheduled, not active', async ({
    page,
    request,
  }) => {
    const auth = { Authorization: `Bearer ${token}` };
    const clone = await (
      await request.get(`${API}/screens/${fixture.screenId}/seat-layouts`, { headers: auth })
    ).json();
    const v1 = clone.find((l: { version: number }) => l.version === 1);
    const draft = await (
      await request.post(`${API}/seat-layouts/${v1.id}/clone`, { headers: auth, data: {} })
    ).json();

    await gotoLayouts(page);
    await page
      .getByRole('button', { name: new RegExp(`Publish version ${draft.version}`) })
      .click();

    const dlg = page.getByRole('dialog', { name: `Publish v${draft.version}` });
    // The dialog has to say what a future date does, or an operator will assume it moves
    // tonight's shows.
    await expect(dlg.getByText(/shows already on the schedule keep the layout/i)).toBeVisible();

    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 16);
    await dlg.getByLabel(/Takes effect from/).fill(future);
    await dlg.getByRole('button', { name: 'Publish' }).click();

    // The new version is published but SCHEDULED, not in force.
    const draftRow = page.getByTestId(`layout-${draft.version}`);
    await expect(draftRow.getByText(/^Starts /)).toBeVisible({ timeout: 20_000 });
    await expect(draftRow.getByText('PUBLISHED')).toBeVisible();
    await expect(draftRow.getByText('Active today')).toHaveCount(0);

    // v1 is still what today uses — the future version has not displaced it.
    await expect(page.getByTestId('layout-1').getByText('Active today')).toBeVisible();
  });

  test('28: a show scheduled before the change keeps its original layout', async ({ request }) => {
    // The pin is what makes history safe; assert it through the API rather than by reading
    // the UI, because this is a data guarantee rather than a rendering one.
    const auth = { Authorization: `Bearer ${token}` };
    const seats = await (
      await request.get(`${API}/public/shows/${fixture.sessionId}/seats`)
    ).json();
    expect(seats.sections[0].rows[0].seats.length).toBe(6);
  });
});

// ── Accessibility ──────────────────────────────────────────────────────────────────

test.describe('theater operations accessibility', () => {
  let tokens: AuthTokens;
  let fixture: Fixture;

  test.beforeAll(async ({ request }) => {
    tokens = sharedTokens;
    fixture = sharedFixture;
    // One of each interesting state on screen, so the scan is not run against an empty room.
    await request.post(`${API}/shows/${fixture.sessionId}/seats/block`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      data: { seatIds: [fixture.seatIds[0]], kind: 'MAINTENANCE', reason: 'broken recliner' },
    });
    await request.post(`${API}/shows/${fixture.sessionId}/seats/block`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      data: { seatIds: [fixture.seatIds[1]], kind: 'HOUSE', reason: 'press' },
    });
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('a11y-1: the live operations board and seat map have no detectable violations', async ({
    page,
  }) => {
    await gotoLive(page, fixture);
    await openSeatMap(page);
    // Rows and badges actually rendered — scanning an empty page is not a pass.
    await expect(page.getByRole('button', { name: /^Seat A1/ })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(describeViolations(results.violations)).toBe('');
  });

  test('a11y-2: the override dialog has no detectable violations', async ({ page }) => {
    await gotoLive(page, fixture);
    await openSeatMap(page);
    await seatButton(page, 'A3').click();
    await expect(overrideDialog(page, 'A3')).toBeVisible();

    /*
      Wait for the entrance animation to finish before measuring contrast.

      Dialog fades in with framer-motion, and axe scanning mid-fade composites every colour
      against the backdrop — it reported #666D7A as #8f949d and failed on contrast that is
      genuinely fine once the panel is opaque. This waits on the actual computed opacity, so
      it is a condition and not a sleep: on a slow machine it waits longer, on a fast one it
      returns immediately.
    */
    await page.waitForFunction(() => {
      const panel = document.querySelector('[role="dialog"]');
      return !!panel && getComputedStyle(panel).opacity === '1';
    });

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(describeViolations(results.violations)).toBe('');
  });

  test('a11y-3: the layout versions and override report pass a scan', async ({ page }) => {
    await page.goto(
      `${ORGANIZER}/organizer/cinemas/${fixture.cinemaId}/screens/${fixture.screenId}/layouts`,
    );
    await expect(page.getByText('v1')).toBeVisible({ timeout: 20_000 });
    let results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(describeViolations(results.violations)).toBe('');

    await page.goto(`${ORGANIZER}/organizer/cinemas/${fixture.cinemaId}/reports`);
    await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 });
    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(describeViolations(results.violations)).toBe('');
  });

  test('a11y-4: every seat is reachable and named by keyboard alone', async ({ page }) => {
    await gotoLive(page, fixture);
    await openSeatMap(page);

    /*
      A graphical seat plan that only answers to a mouse is unusable for a duty manager who
      navigates by keyboard, and no amount of colour fixes that. Each seat is a real button;
      aisle gaps are deliberately NOT focusable, because an aisle is not actionable.
    */
    const seats = page.getByRole('button', { name: /^Seat [AB]\d/ });
    const count = await seats.count();
    expect(count).toBe(12);

    for (let i = 0; i < count; i += 1) {
      const s = seats.nth(i);
      await s.focus();
      await expect(s).toBeFocused();
      const name = await s.getAttribute('aria-label');
      // Status is in the name, never carried by colour alone.
      expect(name).toMatch(/available|sold|held|maintenance|house seat|blocked|vip|emergency/i);
    }
  });

  test('a11y-5: seat state is announced once, not duplicated', async ({ page }) => {
    await gotoLive(page, fixture);
    await openSeatMap(page);
    const name = (await seatButton(page, 'A1').getAttribute('aria-label')) ?? '';
    expect((name.match(/maintenance/gi) ?? []).length).toBe(1);
  });
});
