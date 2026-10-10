import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * The cinema workspace: the film library, a film's showtimes, and whether each one sells.
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────────────
 * Owner's verdict on QA (6b80ad8): the Movies page "looks like a basic database table, not a
 * cinema-management experience". The redesign leads with posters, where each film plays and
 * whether it can be bought. These tests walk it the way a programmer does - by labels and
 * roles only - and pin the one rule that must never bend: a show the server will not sell is
 * never shown as "Selling".
 *
 * Telangana: the seeded database has no ACTIVE India pricing policies, and no test may add or
 * activate one. So, like `sale-eligibility-buyer.spec.ts`, the server's real answer for a
 * Telangana show is put in flight - the readiness SALES blocker with the sentence the API
 * writes, and the public summary's `onlineBooking.open: false` - and what is under test is
 * what the console does with them.
 */

const TG_MESSAGE =
  'Ticket sales are paused for cinemas in Telangana: no state price rules are configured yet. Contact support.';

interface Fixture {
  title: string;
  movieId: string;
  apCinema: { id: string; name: string };
  apScreen: { id: string; name: string };
  tgCinema: { id: string; name: string };
  tgSessionId: string;
}

/** A Kolkata wall-clock date N days out, as the date input wants it. */
const istDate = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
};

async function fixture(request: APIRequestContext, tokens: AuthTokens): Promise<Fixture> {
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;

  const cinema = async (name: string, city: string, region: string) =>
    (
      await request.post(`${API}/cinemas`, {
        headers: auth,
        data: { organizationId, name, city, region, country: 'IN', timezone: 'Asia/Kolkata' },
      })
    ).json();
  const screen = async (cinemaId: string, name: string) => {
    const s = await (
      await request.post(`${API}/cinemas/${cinemaId}/screens`, {
        headers: auth,
        data: { name, screenType: '2D', capacity: 20 },
      })
    ).json();
    await request.post(`${API}/screens/${s.id}/seatmap`, {
      headers: auth,
      data: {
        name: 'Standard',
        sections: [
          {
            name: 'Stalls',
            categoryName: 'Stalls',
            basePriceMinor: 15_000,
            rowLabels: ['A', 'B'],
            seatsPerRow: 10,
          },
        ],
      },
    });
    return s;
  };

  const ap = await cinema(`Vijayawada Talkies ${stamp}`, 'Vijayawada', 'Andhra Pradesh');
  const apScreen = await screen(ap.id, `AP Screen ${stamp}`);
  const tg = await cinema(`Hyderabad Screens ${stamp}`, 'Hyderabad', 'Telangana');
  const tgScreen = await screen(tg.id, `TG Audi ${stamp}`);

  const title = `Workspace Film ${stamp}`;
  const movie = await (
    await request.post(`${API}/movies`, {
      headers: auth,
      data: {
        organizationId,
        title,
        runtimeMinutes: 120,
        language: 'Telugu',
        certificate: 'U',
        genres: ['Drama'],
      },
    })
  ).json();
  expect(movie.id, `movie creation failed: ${JSON.stringify(movie)}`).toBeTruthy();
  await request.post(`${API}/movies/${movie.id}/status`, {
    headers: auth,
    data: { status: 'PUBLISHED' },
  });

  // The Telangana show is made through the API; the Andhra Pradesh one through the console.
  const tgStart = new Date(`${istDate(40)}T18:00:00+05:30`);
  const tgShow = await (
    await request.post(`${API}/movies/${movie.id}/shows`, {
      headers: auth,
      data: {
        screenId: tgScreen.id,
        startsAt: tgStart.toISOString(),
        endsAt: new Date(tgStart.getTime() + 135 * 60_000).toISOString(),
      },
    })
  ).json();
  expect(tgShow.sessionId, `show scheduling failed: ${JSON.stringify(tgShow)}`).toBeTruthy();

  return {
    title,
    movieId: movie.id,
    apCinema: { id: ap.id, name: ap.name },
    apScreen: { id: apScreen.id, name: apScreen.name },
    tgCinema: { id: tg.id, name: tg.name },
    tgSessionId: tgShow.sessionId,
  };
}

/** The server's answer for a Telangana show, as QA sends it today. */
async function telanganaRefuses(page: Page, fx: Fixture) {
  await page.route(`**/cinemas/${fx.tgCinema.id}/pilot-readiness`, async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    report.sections = report.sections.filter((s: { section: string }) => s.section !== 'SALES');
    report.sections.push({
      section: 'SALES',
      level: 'BLOCKED',
      checks: [
        {
          section: 'SALES',
          code: 'SALE_NO_PRICING_POLICY',
          level: 'BLOCKED',
          message: TG_MESSAGE,
          fixPath: null,
        },
      ],
    });
    await route.fulfill({ response, json: report });
  });
  await page.route(`**/public/shows/${fx.tgSessionId}`, async (route) => {
    const response = await route.fetch();
    const summary = await response.json();
    summary.onlineBooking = {
      open: false,
      message: 'Online booking is not open for this show yet.',
      closedTicketTypeIds: [],
    };
    await route.fulfill({ response, json: summary });
  });
}

test.describe('cinema workspace', () => {
  let tokens: AuthTokens;
  let fx: Fixture;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, 'owner@eticketsgo.test');
    fx = await fixture(request, tokens);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('library -> film -> schedule a show at an AP cinema -> see it -> open its layout preview', async ({
    page,
  }) => {
    await telanganaRefuses(page, fx);
    await page.goto(`${ORGANIZER}/organizer/movies`);

    // The library finds the film by its title, and says where it plays.
    await page.getByPlaceholder('Search by title, cast or director').fill(fx.title);
    const card = page.getByRole('article', { name: fx.title });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('1 upcoming show');
    await expect(card).toContainText(fx.tgCinema.name);

    await card.getByRole('link', { name: `Manage ${fx.title}` }).click();
    await expect(page.getByRole('heading', { level: 1, name: fx.title })).toBeVisible({
      timeout: 30_000,
    });

    // One show, from the labelled More menu.
    await page.getByRole('button', { name: `More actions for ${fx.title}` }).click();
    await page.getByRole('menuitem', { name: 'Schedule one show' }).click();
    const dialog = page.getByRole('dialog', { name: 'Schedule show' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Cinema').selectOption(fx.apCinema.id);
    await dialog.getByLabel('Screen').selectOption(fx.apScreen.id);
    const day = istDate(41);
    const starts = dialog.getByRole('group', { name: 'Starts at' });
    await starts.getByLabel('Date').fill(day);
    await starts.getByLabel('Time', { exact: true }).selectOption('19:00');
    const ends = dialog.getByRole('group', { name: 'Ends at' });
    await ends.getByLabel('Date').fill(day);
    await ends.getByLabel('Time', { exact: true }).selectOption('21:30');
    await dialog.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // It is in the list, at 19:00 cinema time, and - with nothing refusing it - selling.
    const details = page.getByRole('button', {
      name: new RegExp(`^Details for the .* show at ${fx.apCinema.name}$`),
    });
    await expect(details).toBeVisible({ timeout: 30_000 });
    const row = page.getByRole('listitem').filter({ has: details });
    await expect(row).toContainText('19:00');
    await expect(row).toContainText(fx.apScreen.name);
    await expect(row.getByText('Selling', { exact: true })).toBeVisible({ timeout: 30_000 });

    // The quick look names the screen and the layout version, and opens its preview.
    await details.click();
    const drawer = page.getByRole('dialog', { name: /^Show at / });
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText(/layout version \d+/);
    await expect(drawer.getByRole('link', { name: /Seat map for/ })).toHaveAttribute(
      'href',
      `/organizer/cinemas/${fx.apCinema.id}/screens/${fx.apScreen.id}/seatmap`,
    );
    // Escape closes it and puts focus back on the button that opened it.
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(details).toBeFocused();

    await details.click();
    await drawer.getByRole('link', { name: 'Preview this layout' }).click();
    await expect(page).toHaveURL(
      new RegExp(
        `/organizer/cinemas/${fx.apCinema.id}/screens/${fx.apScreen.id}/layouts/[^/]+/preview`,
      ),
      { timeout: 30_000 },
    );
  });

  test('a Telangana cinema shows "Not selling" with the plain reason, never "Selling"', async ({
    page,
  }) => {
    await telanganaRefuses(page, fx);
    await page.goto(`${ORGANIZER}/organizer/movies/${fx.movieId}`);

    const details = page.getByRole('button', {
      name: new RegExp(`^Details for the .* show at ${fx.tgCinema.name}$`),
    });
    await expect(details).toBeVisible({ timeout: 30_000 });
    const row = page.getByRole('listitem').filter({ has: details });
    await expect(row.getByText('Not selling: Telangana pricing rules not configured')).toBeVisible({
      timeout: 30_000,
    });
    await expect(row.getByText('Selling', { exact: true })).toHaveCount(0);

    // The quick look carries the server's own sentence and the way to the readiness page.
    await details.click();
    const drawer = page.getByRole('dialog', { name: /^Show at / });
    await expect(drawer).toContainText(TG_MESSAGE);
    await expect(drawer.getByRole('link', { name: 'Cinema readiness' })).toHaveAttribute(
      'href',
      `/organizer/cinemas/${fx.tgCinema.id}/readiness`,
    );
    await page.keyboard.press('Escape');

    // And the library names the exception on the film's card.
    await page.goto(`${ORGANIZER}/organizer/movies`);
    await page.getByPlaceholder('Search by title, cast or director').fill(fx.title);
    const card = page.getByRole('article', { name: fx.title });
    // "Not selling at <cinema>: ..." beside an AP show that sells, or the film's own verdict
    // when Telangana is all it has (this test run on its own).
    await expect(card).toContainText(/Telangana pricing rules not configured/, { timeout: 30_000 });
    await expect(card).not.toContainText(/Not selling at .* Andhra/);
  });
});
