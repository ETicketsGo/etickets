import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, CUSTOMER, apiLogin } from './helpers';

/**
 * An aisle is not a seat, and a wheelchair space says so — in the browser.
 *
 * The API side is pinned by a real-Postgres test. This is the half a customer meets: that
 * the gap is drawn as a gap rather than offered as a seat, that the accessible seats carry a
 * mark AND a name, and that the legend explains the mark rather than leaving it to be
 * guessed at.
 *
 * Builds its own room because the seeded cinema has no aisles or accessible seating — which
 * is exactly why none of this was noticed.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

/** Rows A–E of ten: a wheelchair pair in A, and an aisle running down seat 5. */
async function buildRoomWithAnAisle(request: APIRequestContext): Promise<string> {
  const { accessToken } = await apiLogin(request, ORGANIZER_EMAIL);
  const auth = { Authorization: `Bearer ${accessToken}` };

  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const cinemas = await (
    await request.get(`${API}/cinemas?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const cinemaId = (Array.isArray(cinemas) ? cinemas : cinemas.data)[0].id;

  // A screen of its own, so repeated runs never collide over a showtime.
  const screen = await (
    await request.post(`${API}/cinemas/${cinemaId}/screens`, {
      headers: auth,
      data: { name: `Aisle E2E ${Date.now()}`, screenType: '2D', capacity: 50 },
    })
  ).json();

  await request.post(`${API}/screens/${screen.id}/seatmap`, {
    headers: auth,
    data: {
      name: 'Balcony',
      sections: [
        {
          name: 'Balcony',
          categoryName: 'Balcony',
          basePriceMinor: 15_000,
          rowLabels: ['A', 'B', 'C', 'D', 'E'],
          seatsPerRow: 10,
          seatKinds: [
            { rowLabel: 'A', seats: [1, 10], kind: 'WHEELCHAIR' },
            { rowLabel: 'A', seats: [2], kind: 'COMPANION' },
            ...['A', 'B', 'C', 'D', 'E'].map((rowLabel) => ({
              rowLabel,
              seats: [5],
              kind: 'GAP',
            })),
          ],
        },
      ],
    },
  });

  const movies = await (
    await request.get(`${API}/movies?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const movieId = (Array.isArray(movies) ? movies : movies.data)[0].id;

  const startsAt = new Date(Date.now() + 150 * 86_400_000);
  const res = await request.post(`${API}/movies/${movieId}/shows`, {
    headers: auth,
    data: {
      screenId: screen.id,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 3 * 3_600_000).toISOString(),
    },
  });
  const show = await res.json();
  expect(res.ok(), `scheduling failed: ${JSON.stringify(show)}`).toBe(true);
  return show.sessionId;
}

test.describe('a room with an aisle and a wheelchair bay', () => {
  let sessionId = '';

  test.beforeAll(async ({ request }) => {
    sessionId = await buildRoomWithAnAisle(request);
  });

  test('1: the aisle is not on sale', async ({ page }) => {
    await page.goto(`${CUSTOMER}/shows/${sessionId}`);
    await expect(page.getByRole('heading', { name: 'Select seats' })).toBeVisible();

    /*
      Forty-five, not fifty.

      Every position used to be offered, so the five aisle squares were bookable — a customer
      could buy A5 and turn up to a corridor. Reproduced end to end before this was fixed:
      the booking succeeded.
    */
    await expect(page.locator('button[aria-label^="Seat"]')).toHaveCount(45);
    // And specifically the one that runs down the middle of every row.
    await expect(page.locator('button[aria-label^="Seat A5"]')).toHaveCount(0);
    await expect(page.locator('button[aria-label^="Seat C5"]')).toHaveCount(0);
  });

  test('2: removing the aisle does not renumber the row', async ({ page }) => {
    // Seat numbers are printed on the seats. If dropping A5 shifted A6 into its place, every
    // ticket past the aisle would name a seat the customer is not sitting in.
    await page.goto(`${CUSTOMER}/shows/${sessionId}`);
    await expect(page.locator('button[aria-label^="Seat A4"]')).toHaveCount(1);
    await expect(page.locator('button[aria-label^="Seat A6"]')).toHaveCount(1);
    await expect(page.locator('button[aria-label^="Seat A10"]')).toHaveCount(1);
  });

  test('3: an accessible seat is named, not just marked', async ({ page }) => {
    await page.goto(`${CUSTOMER}/shows/${sessionId}`);

    /*
      The mark and the name, both.

      A symbol alone is invisible to a screen reader; a label alone is invisible to everyone
      else. `kind` never reached the client at all, so a wheelchair bay rendered as an
      ordinary seat and the customer who needed it could not find it.
    */
    await expect(page.locator('button[aria-label*="wheelchair space"]')).toHaveCount(2);
    await expect(page.locator('button[aria-label*="companion seat"]')).toHaveCount(1);
    await expect(page.getByText('Wheelchair space or companion seat')).toBeVisible();
  });

  test('4: an accessible seat is still bookable, and keeps its name at checkout', async ({
    page,
  }) => {
    // It is a seat somebody sits in — marking it must not take it off sale.
    await page.goto(`${CUSTOMER}/shows/${sessionId}`);
    const bay = page.locator('button[aria-label*="wheelchair space"]').first();
    const name = /Seat\s+([A-Z]+\d+)/i.exec((await bay.getAttribute('aria-label')) ?? '')?.[1];
    expect(name).toBeTruthy();

    await bay.click();
    await expect(page.getByText(name!, { exact: false }).first()).toBeVisible();
  });

  test('5: a room without accessible seating says nothing about it', async ({ page, request }) => {
    /*
      The legend only appears when the room has one.

      An entry for a mark that is nowhere on the map teaches a customer to look for something
      they will never find — which is worse than not mentioning it.
    */
    /*
      Chosen by what the layout IS, not by position in a list.

      Picking "the first showtime" found whichever room the previous test run had left
      lying about — including a sectioned arena, which opens on a venue map and has no
      "Select seats" heading at all. The room this test needs is a specific thing: an
      ordinary seat grid with no accessible seating in it.
    */
    const movies = await (await request.get(`${API}/public/movies`)).json();
    const list = Array.isArray(movies) ? movies : movies.data;

    let plainSession: string | undefined;
    for (const movie of list) {
      const shows = await (await request.get(`${API}/public/movies/${movie.slug}/shows`)).json();
      for (const show of shows.shows ?? []) {
        if (show.sessionId === sessionId) continue;
        const layout = await (
          await request.get(`${API}/public/shows/${show.sessionId}/seats`)
        ).json();
        if (layout.view !== 'seats') continue;
        const seats = layout.sections.flatMap((sec: { rows: { seats: { kind: string }[] }[] }) =>
          sec.rows.flatMap((r) => r.seats),
        );
        if (seats.some((x: { kind: string }) => x.kind !== 'SEAT')) continue;
        plainSession = show.sessionId;
        break;
      }
      if (plainSession) break;
    }
    expect(plainSession, 'the seed should have an ordinary cinema room').toBeTruthy();

    await page.goto(`${CUSTOMER}/shows/${plainSession}`);
    await expect(page.getByRole('heading', { name: 'Select seats' })).toBeVisible();
    await expect(page.getByText('Wheelchair space or companion seat')).toHaveCount(0);
  });
});
