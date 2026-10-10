import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, CUSTOMER, apiLogin } from './helpers';

/**
 * The event page when its images do not load.
 *
 * Found on QA with a forced 404: the hero became a black box with the browser's broken-image
 * icon, and the thumbnails under it were broken icons too. Cards already fell back to the
 * event's lettered gradient; the event page now does the same, and drops a failed image from
 * the thumbnails and the viewer instead of offering a picture that is not there.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function findPublishedEvent(request: APIRequestContext, auth: Record<string, string>) {
  const orgs = (await (await request.get(`${API}/organizations`, { headers: auth })).json()) as {
    id: string;
  }[];
  for (const org of orgs) {
    const events = (await (
      await request.get(`${API}/events?organizationId=${org.id}`, { headers: auth })
    ).json()) as { id: string; slug: string; status: string }[];
    const live = events.find((event) => event.status === 'PUBLISHED');
    if (live) return live;
  }
  return undefined;
}

/*
  Records every image load that fails, before the page's own scripts run. Error events do not
  bubble, but they do pass through a capturing listener on the window.

  Detected this way rather than by `naturalWidth === 0`, because with a srcset Chrome reports
  the natural size divided by the chosen density - and the 1x1 fixture used here, drawn from a
  1600w candidate, rounds to 0 while being a perfectly good picture.
*/
async function recordImageErrors(page: Page) {
  await page.addInitScript(() => {
    const failed = new Set<string>();
    (window as unknown as { __failedImages: Set<string> }).__failedImages = failed;
    window.addEventListener(
      'error',
      (event) => {
        const target = event.target;
        if (target instanceof HTMLImageElement) failed.add(target.currentSrc || target.src);
      },
      true,
    );
  });
}

/** Images on screen whose load failed: what a buyer sees as the broken-image icon. */
function visibleBrokenImages(page: Page) {
  return page.evaluate(() => {
    const failed = (window as unknown as { __failedImages: Set<string> }).__failedImages;
    return [...document.images].filter(
      (img) => img.getClientRects().length > 0 && failed.has(img.currentSrc || img.src),
    ).length;
  });
}

/** Whether the page tried, and failed, to load at least one event image. */
function sawAFailedImage(page: Page) {
  return page.evaluate(() =>
    [...(window as unknown as { __failedImages: Set<string> }).__failedImages].some((src) =>
      src.includes('/images/'),
    ),
  );
}

test.describe('event page images that fail to load', () => {
  let auth: Record<string, string>;
  let live: { id: string; slug: string } | undefined;
  const added: string[] = [];

  test.beforeAll(async ({ request }) => {
    const owner = await apiLogin(request, 'owner@eticketsgo.test');
    auth = { Authorization: `Bearer ${owner.accessToken}` };
    live = await findPublishedEvent(request, auth);
    if (!live) return;
    for (const name of ['hero-a.png', 'hero-b.png']) {
      const res = await request.post(`${API}/events/${live.id}/images`, {
        headers: auth,
        multipart: { file: { name, mimeType: 'image/png', buffer: PNG } },
      });
      expect(res.status()).toBe(201);
      const gallery = (await res.json()) as { images: { id: string }[] };
      added.push(gallery.images[gallery.images.length - 1].id);
    }
  });

  test.afterAll(async ({ request }) => {
    // Leave the seeded event as it was found.
    for (const id of added) {
      await request.delete(`${API}/events/${live!.id}/images/${id}`, { headers: auth });
    }
  });

  test('every image failing shows the placeholder, never a broken icon', async ({ page }) => {
    test.skip(!live, 'the seeded organizer has no published event');
    await page.route(new RegExp(`/public/events/${live!.id}/images?(/|\\?|$)`), (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );
    await recordImageErrors(page);
    await page.goto(`${CUSTOMER}/events/${live!.slug}`);

    await expect(page.getByTestId('event-hero-placeholder')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect.poll(() => sawAFailedImage(page)).toBe(true);
    await expect.poll(() => visibleBrokenImages(page)).toBe(0);
    // Nothing offers a picture that is not there: no thumbnails, no full-screen button.
    await expect(page.getByRole('button', { name: /^Show image / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /photo/i })).toHaveCount(0);
  });

  test('one image failing drops it and keeps the others', async ({ page }) => {
    test.skip(!live, 'the seeded organizer has no published event');
    const [broken] = added;
    await page.route(new RegExp(`/public/events/${live!.id}/images/${broken}`), (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );
    await recordImageErrors(page);
    await page.goto(`${CUSTOMER}/events/${live!.slug}`);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
    // The page did try the broken image, so a clean result below means it was taken down.
    await expect.poll(() => sawAFailedImage(page)).toBe(true);
    await expect.poll(() => visibleBrokenImages(page)).toBe(0);
    await expect(page.getByTestId('event-hero-placeholder')).toHaveCount(0);
    // The hero still opens the photos that did load.
    await expect(page.getByRole('button', { name: /photo/i }).first()).toBeVisible();
  });
});
