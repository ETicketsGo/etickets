import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * One show, one answer, on every organizer screen.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * QA, 2026-10-10 (main 5acd4ad): the same Vijayawada show read "Not selling: 1 problem to fix"
 * on the Overview and "Selling" in the cinema workspace drawer, while checkout sold its mapped
 * seat category and refused the other. Four screens worked "selling" out four ways.
 *
 * Every screen now renders the server's unified sale state. This walks ONE fixture through the
 * Overview (the week's programme and "Your events"), the event list, the event page and the
 * cinema workspace (library card, film page, show row and drawer), by labels and roles only,
 * and holds them to one sentence.
 *
 * ── THE FIXTURE ────────────────────────────────────────────────────────────────────
 * A film at an Andhra Pradesh cinema with two seat categories, in the next half hour. Partial
 * without touching any pricing rule: the Standard tickets' booking window opens later, which
 * checkout refuses today ("not currently on sale") while Gold sells. Then the window is
 * cleared and every screen must say "Selling". No pricing policy is read or written.
 */

const PARTIAL = 'Partly selling: bookings not open yet';

interface Fixture {
  start: Date;
  title: string;
  movieId: string;
  eventId: string;
  sessionId: string;
  standardId: string;
  cinemaName: string;
}

async function fixture(request: APIRequestContext, tokens: AuthTokens): Promise<Fixture> {
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;

  const cinemaName = `Agreement Talkies ${stamp}`;
  const cinema = await (
    await request.post(`${API}/cinemas`, {
      headers: auth,
      data: {
        organizationId,
        name: cinemaName,
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
      data: { name: `Agreement Screen ${stamp}`, screenType: '2D', capacity: 20 },
    })
  ).json();
  await request.post(`${API}/screens/${screen.id}/seatmap`, {
    headers: auth,
    data: {
      name: 'Two classes',
      sections: [
        {
          name: 'Gold',
          categoryName: 'Gold',
          basePriceMinor: 18_000,
          rowLabels: ['A'],
          seatsPerRow: 10,
        },
        {
          name: 'Standard',
          categoryName: 'Standard',
          basePriceMinor: 15_000,
          rowLabels: ['B'],
          seatsPerRow: 10,
        },
      ],
    },
  });

  const title = `Agreement Film ${stamp}`;
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

  /*
    Soon - the next half hour - so it is the organization's next show still to start: the first
    of the Overview's "Upcoming events" cards, and on its "Today" list.
  */
  const start = new Date(Math.ceil((Date.now() + 30 * 60_000) / 300_000) * 300_000);
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
  expect(show.sessionId, `show scheduling failed: ${JSON.stringify(show)}`).toBeTruthy();

  const pricing = await (
    await request.get(`${API}/shows/${show.sessionId}/pricing`, { headers: auth })
  ).json();
  const standard = pricing.categories.find((c: { name: string }) => c.name === 'Standard');
  expect(standard, JSON.stringify(pricing)).toBeTruthy();

  const from = new Date().toISOString();
  const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const calendar = await (
    await request.get(
      `${API}/organizer-calendar?organizationId=${organizationId}&from=${from}&to=${to}`,
      { headers: auth },
    )
  ).json();
  const row = calendar.sessions.find((s: { id: string }) => s.id === show.sessionId);
  expect(row, 'the show is on the calendar').toBeTruthy();

  return {
    start,
    title,
    movieId: movie.id,
    eventId: row.event.id,
    sessionId: show.sessionId,
    standardId: standard.ticketTypeId,
    cinemaName,
  };
}

async function setStandardWindow(
  request: APIRequestContext,
  tokens: AuthTokens,
  fx: Fixture,
  salesStartAt: string | null,
) {
  const res = await request.patch(`${API}/events/ticket-types/${fx.standardId}`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    data: { salesStartAt },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

/** The sentence, and never bare "Selling" beside it when the sentence is partial. */
async function says(where: Locator, label: string) {
  await expect(where.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  if (label !== 'Selling') await expect(where.getByText('Selling', { exact: true })).toHaveCount(0);
}

async function everyScreenSays(page: Page, fx: Fixture, label: string) {
  /*
    1. The Overview: the event's card under "Upcoming events" (the event's answer, over all its
    shows) and the show's row in the month card's "Today" list (the show's own answer).
  */
  await page.goto(`${ORGANIZER}/organizer`);
  const upcoming = page.getByRole('region', { name: 'Upcoming events' });
  await says(upcoming.getByRole('article').filter({ hasText: fx.title }), label);
  /*
    The "Today" list holds the shows on today's date at their venue. The fixture show starts about
    half an hour from now, so from 23:30 at the venue (Asia/Kolkata) it falls on tomorrow and is
    rightly absent - which failed main and #303 at 18:01 UTC on 2026-10-10. Only assert the row
    when the show really is on today's venue date.
  */
  const venueDay = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
  if (venueDay(fx.start) === venueDay(new Date())) {
    const today = page.getByRole('list', { name: 'Shows today' });
    await says(today.getByRole('listitem').filter({ hasText: fx.title }), label);
  }

  // 2. The event list, as a card.
  await page.goto(`${ORGANIZER}/organizer/events`);
  await page.getByRole('searchbox').first().fill(fx.title);
  await says(page.getByRole('article').filter({ hasText: fx.title }), label);

  // 3. The event page.
  await page.goto(`${ORGANIZER}/organizer/events/${fx.eventId}`);
  const sales = page.getByRole('term').filter({ hasText: /^Sales$/ });
  await says(page.locator('div', { has: sales }).last(), label);

  // 4. The cinema workspace: the library card, the film page, the show's row, its quick look.
  await page.goto(`${ORGANIZER}/organizer/movies`);
  await page.getByPlaceholder('Search by title, cast or director').fill(fx.title);
  await says(page.getByRole('article', { name: fx.title }), label);

  await page.goto(`${ORGANIZER}/organizer/movies/${fx.movieId}`);
  await expect(page.getByRole('heading', { level: 1, name: fx.title })).toBeVisible({
    timeout: 30_000,
  });
  // The film's own chip and the show's: one sentence, and nowhere a bare "Selling" beside it.
  await says(page.getByRole('main'), label);
  const details = page.getByRole('button', {
    name: new RegExp(`^Details for the .* show at ${fx.cinemaName}$`),
  });
  await expect(details).toBeVisible({ timeout: 30_000 });
  await says(page.getByRole('listitem').filter({ has: details }), label);
  await details.click();
  const drawer = page.getByRole('dialog', { name: /^Show at / });
  await says(drawer, label);
  await page.keyboard.press('Escape');
}

test.describe('one sale state across the organizer console', () => {
  let tokens: AuthTokens;
  let fx: Fixture;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, 'owner@eticketsgo.test');
    fx = await fixture(request, tokens);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('a show with one category not yet on sale is "Partly selling" everywhere', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await setStandardWindow(request, tokens, fx, new Date(Date.now() + 86_400_000).toISOString());
    await everyScreenSays(page, fx, PARTIAL);
  });

  test('with every category open it is "Selling" everywhere', async ({ page, request }) => {
    test.setTimeout(180_000);
    await setStandardWindow(request, tokens, fx, null);
    await everyScreenSays(page, fx, 'Selling');
  });
});
