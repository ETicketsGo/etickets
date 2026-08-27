import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORGANIZER, apiLogin } from './helpers';

/**
 * Describing a room without knowing its row letters.
 *
 * The form used to ask for "Rows" as "A-T" and "Seats per row". An organizer with a
 * hundred-seat cinema does not know whether that is A–S, A–Z or A–M, and said so twice.
 * They know how big the room is and what kind of room it is; the arithmetic is the
 * software's job.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

async function blankScreen(request: APIRequestContext) {
  const { accessToken } = await apiLogin(request, ORGANIZER_EMAIL);
  const auth = { Authorization: `Bearer ${accessToken}` };
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const cinemas = await (
    await request.get(`${API}/cinemas?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const cinemaId = (Array.isArray(cinemas) ? cinemas : cinemas.data)[0].id;
  // A screen with no seat map, so the page opens on the builder.
  const screen = await (
    await request.post(`${API}/cinemas/${cinemaId}/screens`, {
      headers: auth,
      data: { name: `Room shape E2E ${Date.now()}`, screenType: '2D', capacity: 200 },
    })
  ).json();
  return { cinemaId, screenId: screen.id as string };
}

test.describe('describing a room', () => {
  let ids: { cinemaId: string; screenId: string };

  test.beforeAll(async ({ request }) => {
    ids = await blankScreen(request);
  });

  test.beforeEach(async ({ context, request }) => {
    const tokens = await apiLogin(request, ORGANIZER_EMAIL);
    await context.addInitScript((t) => {
      localStorage.setItem('etg_access', t.accessToken);
      localStorage.setItem('etg_refresh', t.refreshToken);
    }, tokens);
  });

  const open = (page: import('@playwright/test').Page) =>
    page.goto(`${ORGANIZER}/organizer/cinemas/${ids.cinemaId}/screens/${ids.screenId}/seatmap`, {
      waitUntil: 'networkidle',
    });

  test('1: a capacity and a room type is all it takes', async ({ page }) => {
    await open(page);
    await expect(page.getByText('What kind of room is this?')).toBeVisible();
    await page.getByLabel('About how many seats?').fill('100');
    await expect(page.getByText(/\d+ rows of \d+ — \d+ seats to sell/)).toBeVisible();
    // The row letters are worked out, not typed.
    await expect(page.getByText(/Rows A–[A-Z]/)).toBeVisible();
  });

  test('2: the same capacity gives a different room for a different shape', async ({ page }) => {
    /*
      The reason the shape is asked for at all. A hundred seats in a hall is nearly square;
      on a screen it is long rows. If both produced the same grid the question would be
      pointless.
    */
    await open(page);
    await page.getByLabel('About how many seats?').fill('100');
    await page.getByRole('button', { name: /Standard screen/ }).click();
    const screen = await page.getByText(/\d+ rows of \d+ —/).innerText();
    await page.getByRole('button', { name: /Flat hall/ }).click();
    const hall = await page.getByText(/\d+ rows of \d+ —/).innerText();
    expect(hall).not.toBe(screen);
  });

  test('3: the headline number is the number you can sell', async ({ page }) => {
    /*
      The bug this pins.

      Planning on the grid meant "100 seats" headlined 100 while the preview underneath
      counted 90 — the aisle column being sold as part of the house. Every number on the
      page has to be the same number.
    */
    await open(page);
    await page.getByLabel('About how many seats?').fill('100');

    const headline = await page.getByText(/\d+ rows of \d+ — \d+ seats to sell/).innerText();
    const promised = Number(/— (\d+) seats to sell/.exec(headline)?.[1]);
    expect(promised).toBeGreaterThanOrEqual(100);

    // The live preview and the page footer must agree with it.
    await expect(page.getByText(`${promised} bookable seats`).first()).toBeVisible();
    // Two places say it, so both must be the same number — that is the whole assertion.
    await expect(page.getByText(`${promised} bookable seats`)).toHaveCount(2);
  });

  test('4: the exact fields are still there for anyone who wants them', async ({ page }) => {
    // Deriving something and hiding it only moves the confusion. The rows and seats-per-row
    // the picker chose are visible and editable.
    await open(page);
    await page.getByLabel('About how many seats?').fill('100');
    // `<details>` opens on its summary; clicking the text inside it is not always the summary.
    await page.locator('summary', { hasText: 'Set it exactly' }).click();
    await expect(page.getByLabel('Rows')).toBeVisible();
    await expect(page.getByLabel('Seats per row')).toBeVisible();
    await expect(page.getByLabel('Seats per row')).not.toHaveValue('');
  });
});
