import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * A film show on the calendar opens its FILM's page, not the generic event page.
 *
 * The calendar rows carried the event id only, so every cinema session linked to
 * /organizer/events/<id>, where a film's screens and shows are not run. The API now sends the
 * film id; the row, the quick look and the Overview's month card link to
 * /organizer/movies/<id>?show=<session>, and the film page scrolls to that show's day.
 * Non-film sessions keep their own pages (checked in the unit tests of the destination helper).
 */

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

interface Fixture {
  title: string;
  movieId: string;
  sessionId: string;
  day: string;
}

async function fixture(request: APIRequestContext, tokens: AuthTokens): Promise<Fixture> {
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const cinema = await (
    await request.post(`${API}/cinemas`, {
      headers: auth,
      data: {
        organizationId,
        name: `Film Link Talkies ${stamp}`,
        city: 'Vijayawada',
        region: 'Andhra Pradesh',
        country: 'IN',
        timezone: 'Asia/Kolkata',
      },
    })
  ).json();
  const screen = await (
    await request.post(`${API}/cinemas/${cinema.id}/screens`, {
      headers: auth,
      data: { name: `Film Link Screen ${stamp}`, screenType: '2D', capacity: 10 },
    })
  ).json();
  await request.post(`${API}/screens/${screen.id}/seatmap`, {
    headers: auth,
    data: {
      name: 'One class',
      sections: [
        {
          name: 'Gold',
          categoryName: 'Gold',
          basePriceMinor: 18_000,
          rowLabels: ['A'],
          seatsPerRow: 10,
        },
      ],
    },
  });
  const title = `Film Link Film ${stamp}`;
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
  expect(movie.id, JSON.stringify(movie)).toBeTruthy();
  // Three days out, mid-afternoon at the cinema: the same date at the venue and in India.
  const start = new Date(Date.now() + 3 * 86_400_000);
  start.setUTCHours(9, 0, 0, 0);
  const show = await (
    await request.post(`${API}/movies/${movie.id}/shows`, {
      headers: auth,
      data: {
        screenId: screen.id,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 135 * 60_000).toISOString(),
      },
    })
  ).json();
  expect(show.sessionId, JSON.stringify(show)).toBeTruthy();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(start);
  return { title, movieId: movie.id, sessionId: show.sessionId, day };
}

test.describe('a film show on the calendar opens its film page', () => {
  let tokens: AuthTokens;
  let fx: Fixture;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, 'owner@eticketsgo.test');
    fx = await fixture(request, tokens);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('the API names the film, and the agenda links the row to it', async ({ page, request }) => {
    const orgs = await (
      await request.get(`${API}/organizations`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
    ).json();
    const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
    const from = new Date(Date.now()).toISOString();
    const to = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const cal = await (
      await request.get(
        `${API}/organizer-calendar?organizationId=${organizationId}&from=${from}&to=${to}`,
        {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        },
      )
    ).json();
    const row = cal.sessions.find((s: { id: string }) => s.id === fx.sessionId);
    expect(row.event.movieId).toBe(fx.movieId);
    expect(row.screenId).toBeTruthy();
    expect(row.cinemaId).toBeTruthy();

    await page.goto(`${ORGANIZER}/organizer/calendar?view=agenda&date=${fx.day}`);
    const link = page.getByRole('link', { name: `Open film page: ${fx.title}` });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(link).toHaveAttribute(
      'href',
      `/organizer/movies/${fx.movieId}?show=${fx.sessionId}`,
    );
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/organizer/movies/${fx.movieId}\\?show=`));
    await expect(page.getByRole('heading', { level: 1, name: fx.title })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('the quick look in the month opens the film page too', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/calendar?view=month&date=${fx.day}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    const chip = page.locator(`[data-session-id="${fx.sessionId}"]`).first();
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await chip.click();
    await page
      .getByTestId('calendar-drawer-actions')
      .getByRole('link', { name: 'Open film page' })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/organizer/movies/${fx.movieId}\\?show=${fx.sessionId}`),
    );
  });

  test('the Overview month card lists a chosen day and its row opens the film page', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${ORGANIZER}/organizer`);
    // The shared grid's cell for the show's date; choosing it lists that day's shows below.
    const cell = page.getByTestId(`month-day-${fx.day}`);
    await expect(page.getByRole('heading', { name: 'Welcome back, Omar' })).toBeVisible({
      timeout: 30_000,
    });
    // The show is a few days out: this month's card, or the next one when the month is ending.
    if ((await cell.count()) === 0) await page.getByRole('button', { name: 'Next month' }).click();
    await cell.click();
    const list = page.getByRole('list', { name: /^Shows on / });
    const row = list.getByRole('listitem').filter({ hasText: fx.title });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button').first().click();
    await expect(page).toHaveURL(
      new RegExp(`/organizer/movies/${fx.movieId}\\?show=${fx.sessionId}`),
    );
  });
});
