import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { API, ORGANIZER, apiLogin, futureLocal, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * A new event's images survive whatever happens while they upload.
 *
 * Found as an e2e race on 2026-10-10: the wizard created the event and then uploaded its
 * images, and leaving the page during that upload saved the event without them - silently.
 * Each case here forces one of the ways that goes wrong at the network, with `page.route`, and
 * then checks what the API really holds: how many events, how many images.
 */

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const pixel = (name: string) => ({ name, mimeType: 'image/png', buffer: PIXEL });

const isImageUpload = (url: string, method: string) =>
  method === 'POST' && /\/api\/events\/[^/]+\/images$/.test(url);
const isEventCreate = (url: string, method: string) =>
  method === 'POST' && /\/api\/events$/.test(new URL(url).pathname);

let tokens: AuthTokens;
const created: string[] = [];
const titles: string[] = [];
const titled = (prefix: string) => {
  const title = `${prefix} ${Date.now()}`;
  titles.push(title);
  return title;
};

test.beforeAll(async ({ request }) => {
  tokens = await apiLogin(request, 'owner@eticketsgo.test');
});

test.beforeEach(async ({ context }) => {
  await seedBrowserAuth(context, tokens);
});

test.afterAll(async ({ request }) => {
  // Draft events with no bookings: deleting them takes their images with them. Found by title
  // too, so a run that DID make a second event (the bug these guard) leaves nothing behind.
  for (const title of titles) created.push(...(await eventsTitled(request, title)));
  for (const id of new Set(created)) {
    await request.delete(`${API}/events/${id}`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
  }
});

async function eventsTitled(request: APIRequestContext, title: string) {
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };
  const orgs = (await (await request.get(`${API}/organizations`, { headers: auth })).json()) as {
    id: string;
  }[];
  const found: string[] = [];
  for (const org of orgs) {
    const events = (await (
      await request.get(`${API}/events?organizationId=${org.id}`, { headers: auth })
    ).json()) as { id: string; title: string }[];
    found.push(...events.filter((event) => event.title === title).map((event) => event.id));
  }
  return found;
}

async function imagesOn(request: APIRequestContext, eventId: string) {
  const res = await request.get(`${API}/events/${eventId}`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  return ((await res.json()) as { images?: { id: string }[] }).images ?? [];
}

/** The wizard, answered the way an organizer would, up to Review with two images picked. */
async function fillWizard(page: Page, title: string, open: 'load' | 'in-app' = 'load') {
  if (open === 'load') {
    await page.goto(`${ORGANIZER}/organizer/events/new`);
  } else {
    // A click inside the console, so the wizard is a client-side move from the page before.
    await page.getByRole('link', { name: 'Create event' }).first().click();
    await expect(page).toHaveURL(/\/organizer\/events\/new/);
  }
  await page.getByRole('radio', { name: 'Concert or live music' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Event title').fill(title);
  // The pictures are on the first step, with the title, so the preview has them throughout.
  await page.getByLabel('Event images').setInputFiles([pixel('poster.png'), pixel('stage.png')]);
  await expect(page.getByRole('img', { name: /^Event image \d of 2/ })).toHaveCount(2);
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('group', { name: 'Venue' }).getByRole('radio').first().check();
  const [startDate, startTime] = futureLocal(40, 18).split('T');
  const [endDate, endTime] = futureLocal(40, 22).split('T');
  const performance = page.getByRole('group', { name: 'Performance 1' });
  const starts = performance.getByRole('group', { name: 'Starts at' });
  const ends = performance.getByRole('group', { name: 'Ends at' });
  await starts.getByLabel('Date').fill(startDate);
  await ends.getByLabel('Date').fill(endDate);
  await starts.getByLabel('Time').selectOption(startTime);
  await ends.getByLabel('Time').selectOption(endTime);
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('radio', { name: 'Paid - general admission' }).check();
  await page
    .getByRole('group', { name: 'Ticket type 1' })
    .getByLabel(/^Price/)
    .fill('499');
  await page.getByRole('button', { name: 'Continue' }).click(); // details - nothing required
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Create draft event' })).toBeEnabled();
}

/** The new event's id, read from the create call's answer. */
function eventIdFrom(page: Page): Promise<string> {
  return page
    .waitForResponse((res) => isEventCreate(res.url(), res.request().method()) && res.ok())
    .then(async (res) => {
      const id = ((await res.json()) as { id: string }).id;
      created.push(id);
      return id;
    });
}

test('a reload in the middle of the upload loses nothing: the event page offers Retry, and Retry adds each image once', async ({
  page,
  request,
}) => {
  const title = titled('E2E Interrupted');
  await fillWizard(page, title);

  /*
    The cover's upload REACHES the API and is saved there, but its answer never comes back -
    the page is reloaded first. That is the worst case for a retry: the server has the image
    and the browser does not know it.
  */
  let arrived!: () => void;
  const coverArrived = new Promise<void>((resolve) => (arrived = resolve));
  await page.route(
    (url) => /\/api\/events\/[^/]+\/images$/.test(url.pathname),
    async (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fetch();
      arrived();
      // Never answered.
    },
  );

  const eventId = eventIdFrom(page);
  await page.getByRole('button', { name: 'Create draft event' }).click();
  const id = await eventId;
  const dialog = page.getByRole('dialog', { name: 'Adding your images' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Uploading')).toBeVisible();
  await coverArrived;

  // Leaving now is warned about.
  let warned = false;
  page.on('dialog', (prompt) => {
    if (prompt.type() === 'beforeunload') warned = true;
    void prompt.accept();
  });
  await page.goto(`${ORGANIZER}/organizer/events/${id}`);
  expect(warned).toBe(true);
  // Only now: removed earlier, the held request would be let through and answered after all.
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // The event page knows what did not arrive, on this device, and says so.
  const pending = page.getByRole('region', { name: /2 images are not on this event yet/ });
  await expect(pending).toBeVisible({ timeout: 20_000 });
  await expect(pending.getByText('Image 1 (cover)')).toBeVisible();
  await expect(pending.getByText('Not uploaded: the upload was interrupted.')).toBeVisible();
  await expect(pending.getByText('Waiting')).toBeVisible();

  // A reload of the event page still shows it: it is kept on the device, not in memory.
  await page.reload();
  await expect(pending).toBeVisible({ timeout: 20_000 });

  await pending.getByRole('button', { name: 'Retry upload' }).click();
  // Gone once every file is on the event - not merely renamed to "Adding images".
  await expect(
    page.getByRole('region', { name: /not on this event yet|Adding images/ }),
  ).toHaveCount(0, { timeout: 20_000 });
  // Two pictures picked, two on the event - the cover was sent twice but saved once.
  expect(await imagesOn(request, id)).toHaveLength(2);
  expect(await eventsTitled(request, title)).toEqual([id]);
});

test('a refused upload is shown with Retry, and Retry finishes before the event is submitted', async ({
  page,
  request,
}) => {
  const title = titled('E2E Refused upload');
  await fillWizard(page, title);

  let refused = 0;
  await page.route(
    (url) => /\/api\/events\/[^/]+\/images$/.test(url.pathname),
    async (route: Route) => {
      if (route.request().method() === 'POST' && refused === 0) {
        refused += 1;
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'INTERNAL', message: 'Storage is unavailable.' }),
        });
      }
      return route.fallback();
    },
  );

  const eventId = eventIdFrom(page);
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  const id = await eventId;
  const dialog = page.getByRole('dialog', { name: 'Adding your images' });
  await expect(dialog.getByText(/^Not uploaded: /)).toBeVisible();
  // The second image waited behind the first instead of becoming the cover.
  await expect(dialog.getByText('Waiting')).toBeVisible();
  expect(await imagesOn(request, id)).toHaveLength(0);

  await dialog.getByRole('button', { name: 'Retry upload' }).click();
  await expect(page).toHaveURL(new RegExp(`/organizer/events/${id}$`), { timeout: 20_000 });
  await expect(page.getByText('Stage: In review').first()).toBeVisible({ timeout: 20_000 });
  expect(await imagesOn(request, id)).toHaveLength(2);
});

test('a double click, and a retry after the answer was lost, make ONE event', async ({
  page,
  request,
}) => {
  const title = titled('E2E One event');
  await fillWizard(page, title);

  /*
    The first create reaches the API and makes the event, but the browser is told the network
    failed. The organizer sees the error and presses again.
  */
  let creates = 0;
  await page.route(
    (url) => /\/api\/events$/.test(url.pathname),
    async (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      creates += 1;
      if (creates === 1) {
        await route.fetch();
        return route.abort('failed');
      }
      return route.fallback();
    },
  );

  const button = page.getByRole('button', { name: 'Create draft event' });
  await button.dblclick();
  await expect(page.getByRole('alert').filter({ hasText: /fetch|network|reach/i })).toBeVisible({
    timeout: 20_000,
  });
  expect(creates).toBe(1);

  const eventId = eventIdFrom(page);
  await button.click();
  const id = await eventId;
  await expect(page).toHaveURL(new RegExp(`/organizer/events/${id}$`), { timeout: 20_000 });
  expect(await eventsTitled(request, title)).toEqual([id]);
  expect(await imagesOn(request, id)).toHaveLength(2);
});

test('going back to another console page mid-upload does not stop the upload', async ({
  page,
  request,
}) => {
  const title = titled('E2E Navigate away');
  await page.goto(`${ORGANIZER}/organizer/events`);
  await fillWizard(page, title, 'in-app');

  // Every upload is slow enough to leave in the middle of.
  await page.route(
    (url) => /\/api\/events\/[^/]+\/images$/.test(url.pathname),
    async (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return route.fallback();
    },
  );

  const eventId = eventIdFrom(page);
  await page.getByRole('button', { name: 'Create draft event' }).click();
  const id = await eventId;
  await expect(page.getByRole('dialog', { name: 'Adding your images' })).toBeVisible();
  // The browser's Back: a move inside the console, not a reload.
  await page.goBack();
  await expect(page).toHaveURL(/\/organizer\/events$/);

  // Still uploading on the page the organizer went to, and finished without them.
  await expect.poll(async () => (await imagesOn(request, id)).length, { timeout: 30_000 }).toBe(2);
  // Opening the event shows them attached, and no leftover upload notice.
  await page.goto(`${ORGANIZER}/organizer/events/${id}/edit`);
  await expect(page.getByRole('img', { name: /^Event image \d of 2/ })).toHaveCount(2, {
    timeout: 20_000,
  });
  await expect(page.getByRole('region', { name: /not on this event yet/ })).toHaveCount(0);

  expect(await eventsTitled(request, title)).toEqual([id]);
});
