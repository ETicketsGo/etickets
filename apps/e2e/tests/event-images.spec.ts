import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, CUSTOMER, apiLogin } from './helpers';

/**
 * Several images on a LIVE event, changed without pausing it, and what a buyer then sees.
 *
 * Requested by the owner: images can change while an event is selling, and an event can have
 * more than one. Pausing a live event to change a picture costs real sales; a picture is not
 * part of what a buyer agreed to the way the date or the refund rule is.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Gallery {
  imagePath: string | null;
  images: { id: string; path: string }[];
}

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

test('a live event takes several images without pausing, and buyers can look through them', async ({
  page,
  request,
}) => {
  const owner = await apiLogin(request, 'owner@eticketsgo.test');
  const auth = { Authorization: `Bearer ${owner.accessToken}` };
  const live = await findPublishedEvent(request, auth);
  test.skip(!live, 'the seeded organizer has no published event');

  const add = () =>
    request.post(`${API}/events/${live!.id}/images`, {
      headers: auth,
      multipart: { file: { name: 'live.png', mimeType: 'image/png', buffer: PNG } },
    });

  // Two images onto a PUBLISHED event — this used to be refused until the event was paused.
  const first = await add();
  expect(first.status()).toBe(201);
  const second = await add();
  expect(second.status()).toBe(201);
  const afterAdding = (await second.json()) as Gallery;
  const added = afterAdding.images.slice(-2).map((image) => image.id);

  try {
    // Buyers get every image, cover first, on the public event.
    const published = (await (
      await request.get(`${API}/public/events/${live!.slug}`)
    ).json()) as Gallery;
    expect(published.images.map((image) => image.id)).toEqual(expect.arrayContaining(added));
    expect(published.imagePath).toBe(published.images[0].path);

    // The last image becomes the cover, through the whole-list reorder.
    const ids = published.images.map((image) => image.id);
    const reordered = [ids[ids.length - 1], ...ids.slice(0, -1)];
    const put = await request.put(`${API}/events/${live!.id}/images/order`, {
      headers: auth,
      data: { imageIds: reordered },
    });
    expect(put.ok()).toBe(true);
    const afterOrder = (await put.json()) as Gallery;
    expect(afterOrder.images[0].id).toBe(reordered[0]);
    expect(afterOrder.imagePath).toBe(afterOrder.images[0].path);

    // A stale order — one that does not name every image — is refused, not half-applied.
    const stale = await request.put(`${API}/events/${live!.id}/images/order`, {
      headers: auth,
      data: { imageIds: reordered.slice(1) },
    });
    expect(stale.status()).toBe(409);

    // On the event page, the strip puts any image in the hero.
    await page.goto(`${CUSTOMER}/events/${live!.slug}`);
    const total = ids.length;
    const last = page.getByRole('button', { name: `Show image ${total} of ${total}` });
    await expect(last).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: `Show image 1 of ${total}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await last.click();
    await expect(last).toHaveAttribute('aria-pressed', 'true');
  } finally {
    // Leave the seeded event as it was found.
    for (const id of added) {
      await request.delete(`${API}/events/${live!.id}/images/${id}`, { headers: auth });
    }
  }
});
