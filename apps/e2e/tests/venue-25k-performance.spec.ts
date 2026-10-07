import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, CUSTOMER, apiLogin } from './helpers';

const LIMITS = {
  overviewBytes: 250_000,
  overviewRenderMs: 5_000,
  sectionOpenMs: 3_000,
  sectionSeatButtons: 2_000,
  seatSelectionMs: 500,
};

async function build25k(request: APIRequestContext) {
  const owner = await apiLogin(request, 'owner@eticketsgo.test');
  const auth = { Authorization: `Bearer ${owner.accessToken}` };
  const organizations = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(organizations) ? organizations : organizations.data)[0].id;
  const stamp = Date.now();
  const venue = await (
    await request.post(`${API}/venues`, {
      headers: auth,
      data: {
        organizationId,
        name: `25K Browser Stadium ${stamp}`,
        city: 'Boise',
        region: 'Idaho',
        country: 'United States',
        timezone: 'America/Boise',
        capacity: 30_000,
      },
    })
  ).json();
  const space = await (
    await request.post(`${API}/venues/${venue.id}/spaces`, {
      headers: auth,
      data: { name: 'Main Stadium', screenType: '2D', capacity: 30_000 },
    })
  ).json();
  await request.post(`${API}/screens/${space.id}/seatmap`, {
    headers: auth,
    data: {
      name: 'Starting room',
      sections: [
        {
          name: 'Start',
          categoryName: 'Standard',
          basePriceMinor: 4_000,
          rowLabels: ['A'],
          seatsPerRow: 2,
        },
      ],
    },
  });
  const layouts = await (
    await request.get(`${API}/screens/${space.id}/seat-layouts`, { headers: auth })
  ).json();
  const draft = await (
    await request.post(`${API}/seat-layouts/${layouts[0].id}/clone`, { headers: auth, data: {} })
  ).json();
  const generated = await (
    await request.post(`${API}/seat-layouts/${draft.id}/from-template`, {
      headers: auth,
      data: { template: 'STADIUM', rows: 50, seatsPerRow: 30, basePriceMinor: 4_000 },
      timeout: 120_000,
    })
  ).json();
  expect(generated.seats).toBeGreaterThanOrEqual(25_000);
  await request.post(`${API}/seat-layouts/${draft.id}/publish`, { headers: auth, data: {} });

  const event = await (
    await request.post(`${API}/events`, {
      headers: auth,
      data: {
        organizationId,
        venueId: venue.id,
        title: `25K Browser Scale ${stamp}`,
        category: 'Sports',
        feeMode: 'CUSTOMER_PAYS',
      },
    })
  ).json();
  const startsAt = new Date(Date.now() + 55 * 86_400_000);
  const sessionResponse = await request.post(`${API}/events/${event.id}/sessions`, {
    headers: auth,
    data: {
      screenId: space.id,
      seatMapId: draft.id,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 4 * 3_600_000).toISOString(),
    },
    timeout: 120_000,
  });
  const session = await sessionResponse.json();
  expect(sessionResponse.ok(), JSON.stringify(session)).toBe(true);
  await request.post(`${API}/events/${event.id}/submit`, { headers: auth });
  return { sessionId: session.id, seats: generated.seats as number };
}

test('25K venue stays section-first in the browser and records its costs', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const fixture = await build25k(request);
  const route = `${API}/public/shows/${fixture.sessionId}/seats`;
  let overviewBytes = 0;
  page.on('response', async (response) => {
    if (response.url() === route) overviewBytes = (await response.body()).byteLength;
  });

  const overviewStarted = Date.now();
  await page.goto(`${CUSTOMER}/shows/${fixture.sessionId}`);
  await expect(page.getByRole('heading', { name: 'Choose your area' })).toBeVisible();
  const overviewRenderMs = Date.now() - overviewStarted;
  const overviewButtons = await page
    .getByRole('group', { name: /venue map/i })
    .getByRole('button')
    .count();
  expect(page.getByRole('button', { name: /^Seat / })).toHaveCount(0);

  const firstSection = page
    .getByRole('group', { name: /venue map/i })
    .getByRole('button')
    .first();
  const sectionStarted = Date.now();
  await firstSection.click();
  await expect(page.getByRole('button', { name: /^Seat / }).first()).toBeVisible();
  const sectionOpenMs = Date.now() - sectionStarted;
  const sectionSeatButtons = await page.getByRole('button', { name: /^Seat / }).count();

  const seat = page
    .getByRole('button', { name: /^Seat / })
    .and(page.locator(':enabled'))
    .first();
  const selectionStarted = Date.now();
  await seat.click();
  await expect(seat).toHaveAttribute('aria-pressed', 'true');
  const seatSelectionMs = Date.now() - selectionStarted;
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const panStarted = Date.now();
  await page.locator('[data-testid="seat-map-scroll"]').evaluate((element) => {
    element.scrollLeft = Math.min(240, element.scrollWidth - element.clientWidth);
  });
  const panMs = Date.now() - panStarted;
  const usedHeapBytes = await page.evaluate(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return memory?.usedJSHeapSize ?? null;
  });

  const measurements = {
    seats: fixture.seats,
    overviewBytes,
    overviewRenderMs,
    overviewButtons,
    sectionOpenMs,
    sectionSeatButtons,
    seatSelectionMs,
    panMs,
    usedHeapBytes,
  };
  console.log(`25K_BROWSER_MEASUREMENTS ${JSON.stringify(measurements)}`);

  expect(overviewBytes).toBeGreaterThan(0);
  expect(overviewBytes).toBeLessThan(LIMITS.overviewBytes);
  expect(overviewRenderMs).toBeLessThan(LIMITS.overviewRenderMs);
  expect(sectionOpenMs).toBeLessThan(LIMITS.sectionOpenMs);
  expect(sectionSeatButtons).toBeLessThanOrEqual(LIMITS.sectionSeatButtons);
  expect(seatSelectionMs).toBeLessThan(LIMITS.seatSelectionMs);
});
