import AxeBuilder from '@axe-core/playwright';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, ORGANIZER, apiLogin, login } from './helpers';

/**
 * Accessibility of the scheduling workspace, measured rather than asserted.
 *
 * This runs axe-core against the real rendered page. An "accessibility review" that consists
 * of reading the JSX and declaring it fine is worth very little — the two real defects found
 * on this page (a status announced twice, and state carried only by badge colour) were both
 * invisible in the source and obvious in a tree.
 *
 * WHAT THIS DOES NOT PROVE. Automated tooling catches roughly a third of WCAG issues. It
 * cannot tell whether a label is *meaningful*, whether the reading order makes sense, or
 * whether a colour pairing is legible to a specific person. This suite is a floor, not a
 * certificate, and the docs say so.
 */

const OWNER = 'owner@eticketsgo.test';
const CINEMA_TZ = 'Asia/Kolkata';

function dateLabel(daysAhead: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CINEMA_TZ }).format(
    new Date(Date.now() + daysAhead * 86_400_000),
  );
}

function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

/** A private cinema with one screen, one movie and a few shows across a week. */
async function seedWorkspace(request: APIRequestContext, token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs[0] : orgs.data?.[0])?.id as string;

  const cinema = await (
    await request.post(`${API}/cinemas`, {
      headers: auth,
      data: { organizationId, name: `A11y Multiplex ${suffix}`, city: 'Hyderabad' },
    })
  ).json();
  const screen = await (
    await request.post(`${API}/cinemas/${cinema.id}/screens`, {
      headers: auth,
      data: { name: 'Screen A', screenType: '2D', capacity: 20 },
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
          seatsPerRow: 5,
        },
      ],
    },
  });
  const movie = await (
    await request.post(`${API}/movies`, {
      headers: auth,
      data: {
        organizationId,
        title: `A11y Feature ${suffix}`,
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

  // A week that exercises every badge the view can render, so the scan is not run against
  // a page in its simplest possible state.
  const monday = mondayOf(dateLabel(260));
  const shift = (n: number) =>
    new Date(new Date(`${monday}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

  const seeded = await (
    await request.post(`${API}/movies/${movie.id}/shows/bulk`, {
      headers: auth,
      data: {
        screenId: screen.id,
        dates: [shift(1), shift(3)],
        times: ['10:00', '18:00'],
        padMinutes: 0,
        timezone: CINEMA_TZ,
        dryRun: false,
      },
    })
  ).json();

  // One paused and one cancelled, so warning and error tones are both on screen during the
  // contrast checks.
  await request.post(`${API}/shows/${seeded.created[0].sessionId}/pause`, {
    headers: auth,
    data: { reason: 'staffing' },
  });
  await request.post(`${API}/shows/${seeded.created[1].sessionId}/cancel`, {
    headers: auth,
    data: { reason: 'print not delivered' },
  });

  // `busyDay` is the date the DAY-view scan must use. Pointing that scan at the Monday
  // anchor scanned an empty timeline — no rows, no badges, nothing to fail — and reported a
  // clean pass while the badge colours on it were failing AA. An accessibility scan of a
  // page with no content on it is not a pass, it is a missing test.
  return { cinemaId: cinema.id, monday, busyDay: shift(1) };
}

/**
 * Scan the current page and return violations.
 *
 * Tagged to WCAG 2.1 A and AA, which is the bar an operator tool is normally held to. No
 * rules are disabled: a suppression list is how an accessibility suite becomes decorative.
 */
async function scan(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations;
}

/** Readable failure output — an id and a count tells nobody what to fix. */
const describeViolations = (violations: Awaited<ReturnType<typeof scan>>) =>
  violations
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes
          .slice(0, 3)
          .map((n) => `${n.target.join(' ')} — ${(n.failureSummary ?? '').split('\n').join(' ')}`)
          .join('\n  ')}`,
    )
    .join('\n');

test.describe('scheduling workspace accessibility', () => {
  let cinemaId = '';
  let monday = '';
  let busyDay = '';

  test.beforeAll(async ({ request }) => {
    const { accessToken } = await apiLogin(request, OWNER);
    const seeded = await seedWorkspace(request, accessToken);
    cinemaId = seeded.cinemaId;
    monday = seeded.monday;
    busyDay = seeded.busyDay;
  });

  test.beforeEach(async ({ page }) => {
    await login(page, ORGANIZER, OWNER);
  });

  test('a11y-1: the day view has no automatically detectable violations', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/cinemas/${cinemaId}/schedule`);
    await expect(page.getByLabel('Date', { exact: true })).toBeVisible({ timeout: 20_000 });
    // A day with actual shows on it — see busyDay in the fixture.
    await page.getByLabel('Date', { exact: true }).fill(busyDay);
    await expect(page.getByRole('listitem').first()).toBeVisible({ timeout: 20_000 });

    const violations = await scan(page);
    expect(describeViolations(violations)).toBe('');
  });

  test('a11y-2: the week view has no automatically detectable violations', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/cinemas/${cinemaId}/schedule`);
    await expect(page.getByLabel('Date', { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Date', { exact: true }).fill(monday);
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(page.getByText(/Local dates and times at the cinema/)).toBeVisible({
      timeout: 20_000,
    });

    const violations = await scan(page);
    expect(describeViolations(violations)).toBe('');
  });

  test('a11y-3: every week card is reachable and named by keyboard alone', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/cinemas/${cinemaId}/schedule`);
    await page.getByLabel('Date', { exact: true }).fill(monday);
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(page.getByText(/Local dates and times at the cinema/)).toBeVisible({
      timeout: 20_000,
    });

    /*
      A show card is a real <button>, so it is tabbable and activates on Enter. Rendering it
      as a clickable <div> would look identical, pass a colour-contrast scan, and be
      unreachable without a mouse — which is why this is asserted rather than assumed.
    */
    const cards = page.getByRole('button', { name: /\d{2}:\d{2} .*A11y Feature/ });
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const card = cards.nth(i);
      await card.focus();
      await expect(card).toBeFocused();
      const name = await card.getAttribute('aria-label');
      // The name has to carry time, film, screen and state — a card announced as
      // "10:00" alone forces a screen-reader user to explore to learn anything.
      expect(name).toMatch(/\d{2}:\d{2}/);
      expect(name).toContain('Screen A');
      expect(name).toMatch(/On sale|Sales paused|Cancelled|Not open yet|Booking closed|Finished/);
    }
  });

  test('a11y-4: show state is never announced twice', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/cinemas/${cinemaId}/schedule`);
    await page.getByLabel('Date', { exact: true }).fill(monday);
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(page.getByText(/Local dates and times at the cinema/)).toBeVisible({
      timeout: 20_000,
    });

    /*
      The regression guard for a defect this page already had: a visible badge PLUS an
      sr-only copy of the same words, so assistive tech read "Sales paused Sales paused".
      The accessible name is the single source, and the badge inside it must not repeat.
    */
    const card = page.getByRole('button', { name: /Sales paused/ }).first();
    const name = (await card.getAttribute('aria-label')) ?? '';
    const occurrences = name.match(/Sales paused/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  test('a11y-5: the day/week toggle reports which view is active', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/cinemas/${cinemaId}/schedule`);
    const day = page.getByRole('button', { name: 'Day', exact: true });
    const week = page.getByRole('button', { name: 'Week', exact: true });
    await expect(day).toBeVisible({ timeout: 20_000 });

    // Which view you are in must not be conveyed by button colour alone.
    await expect(day).toHaveAttribute('aria-pressed', 'true');
    await expect(week).toHaveAttribute('aria-pressed', 'false');
    await week.click();
    await expect(week).toHaveAttribute('aria-pressed', 'true');
    await expect(day).toHaveAttribute('aria-pressed', 'false');
  });
});
