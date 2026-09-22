import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, CUSTOMER, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * The details a buyer checks before paying: organizer, artists, age limit, duration, terms.
 *
 * Asked for by the owner alongside a BookMyShow event page. The API and the pure readers have
 * unit tests; this proves what a buyer and an organizer actually see, end to end.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

const TERMS = '1. Tickets cannot be exchanged.\n\n2) Arrive 30 minutes before the show.';

interface Fixture {
  slug: string;
  eventId: string;
  auth: { Authorization: string };
  tokens: Awaited<ReturnType<typeof apiLogin>>;
}

/** A published free event of its own, 90 minutes long, with the given details. */
async function eventWithDetails(
  request: APIRequestContext,
  tokens: Awaited<ReturnType<typeof apiLogin>>,
  details: Record<string, unknown>,
  publish = true,
): Promise<{ slug: string; eventId: string }> {
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const venues = await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const venueId = (Array.isArray(venues) ? venues : venues.data)[0].id;

  const event = await (
    await request.post(`${API}/events`, {
      headers: auth,
      data: {
        organizationId,
        title: `Details Night ${Date.now()}`,
        category: 'Comedy',
        venueId,
        feeMode: 'CUSTOMER_PAYS',
        isFree: true,
        ...details,
      },
    })
  ).json();
  expect(event.id, `event creation failed: ${JSON.stringify(event)}`).toBeTruthy();
  if (!publish) return { slug: event.slug, eventId: event.id };

  const start = Date.now() + 20 * 86_400_000;
  const session = await (
    await request.post(`${API}/events/${event.id}/sessions`, {
      headers: auth,
      data: {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 90 * 60_000).toISOString(),
      },
    })
  ).json();
  await request.post(`${API}/events/ticket-types`, {
    headers: auth,
    data: {
      eventSessionId: session.id,
      name: 'Entry',
      priceMinor: 0,
      quantityTotal: 50,
      maxPerOrder: 4,
    },
  });
  await request.post(`${API}/events/${event.id}/submit`, { headers: auth });
  const admin = await apiLogin(request, 'admin@eticketsgo.test');
  await request.post(`${API}/admin/events/${event.id}/review`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { decision: 'APPROVE' },
  });
  return { slug: event.slug, eventId: event.id };
}

test.describe('event details a buyer checks before paying', () => {
  let full: Fixture;
  let bare: { slug: string };

  test.beforeAll(async ({ request }) => {
    const tokens = await apiLogin(request, ORGANIZER_EMAIL);
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const made = await eventWithDetails(request, tokens, {
      ageLimit: 16,
      termsAndConditions: TERMS,
      artists: [
        { name: 'Venkat Blaze', role: 'Performer', bio: 'Telugu stand-up.' },
        { name: 'Asha Rao', role: 'Host' },
      ],
    });
    full = { ...made, auth, tokens };
    bare = await eventWithDetails(request, tokens, {});
  });

  test('the public event carries them, and the organizer', async ({ request }) => {
    const event = await (await request.get(`${API}/public/events/${full.slug}`)).json();
    expect(event.ageLimit).toBe(16);
    expect(event.termsAndConditions).toBe(TERMS);
    expect(event.artists).toMatchObject([
      { name: 'Venkat Blaze', role: 'Performer', bio: 'Telugu stand-up.' },
      { name: 'Asha Rao', role: 'Host' },
    ]);
    expect(event.organizer).toHaveProperty('verified');
    expect(event.organizer).toHaveProperty('description');
  });

  test('the event page shows age limit, duration, artists, organizer and terms', async ({
    page,
  }) => {
    await page.goto(`${CUSTOMER}/events/${full.slug}`, { waitUntil: 'networkidle' });

    await expect(page.getByText('Age limit: 16+').filter({ visible: true })).toBeVisible();
    // The duration is the show's own start to end, not a separate number.
    await expect(page.getByText('1 hour 30 minutes').filter({ visible: true })).toBeVisible();

    const artists = page.getByRole('heading', { name: 'Artists' });
    await expect(artists).toBeVisible();
    await expect(page.getByText('Venkat Blaze')).toBeVisible();
    await expect(page.getByText('Telugu stand-up.')).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Organizer' })).toBeVisible();

    // Terms open in a dialog, numbered by the page, with the organizer's own numbers removed.
    await page.getByRole('button', { name: 'Terms and conditions' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const items = dialog.getByRole('listitem');
    await expect(items).toHaveText([
      'Tickets cannot be exchanged.',
      'Arrive 30 minutes before the show.',
    ]);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();

    // The note under the pay button opens the same terms.
    await page.getByRole('button', { name: 'Read the terms' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('an event with none of them shows no empty blocks', async ({ page }) => {
    await page.goto(`${CUSTOMER}/events/${bare.slug}`, { waitUntil: 'networkidle' });
    await expect(page.getByText('1 hour 30 minutes').filter({ visible: true })).toBeVisible();
    await expect(page.getByText(/Age limit/)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Artists' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Terms and conditions' })).toHaveCount(0);
  });

  test('the French page says them in French', async ({ page }) => {
    await page.goto(`${CUSTOMER}/fr-CA/events/${full.slug}`, { waitUntil: 'networkidle' });
    await expect(
      page.getByText('Âge minimum : 16 ans et plus').filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByText('1 heure 30 minutes').filter({ visible: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Conditions générales' })).toBeVisible();
  });

  test('an organizer sets and clears them on the edit page', async ({ page, request }) => {
    const draft = await eventWithDetails(request, full.tokens, {}, false);
    await seedBrowserAuth(page.context(), full.tokens);
    await page.goto(`${ORGANIZER}/organizer/events/${draft.eventId}/edit`, {
      waitUntil: 'networkidle',
    });

    await page.getByLabel('Age limit').selectOption('18');
    await page.getByRole('button', { name: 'Add artist' }).click();
    await page.getByLabel('Artist 1 name').fill('Meera Das');
    await page.getByLabel('Role').fill('Speaker');
    await page.getByLabel('Terms and conditions').fill('No re-entry.\nCarry an ID.');
    await expect(page.getByText('Buyers see 2 numbered terms.')).toBeVisible();
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect
      .poll(async () => {
        const res = await request.get(`${API}/events/${draft.eventId}`, { headers: full.auth });
        const body = await res.json();
        return [body.ageLimit, body.artists, body.termsAndConditions];
      })
      .toEqual([18, [{ name: 'Meera Das', role: 'Speaker' }], 'No re-entry.\nCarry an ID.']);

    // Cleared means cleared, not "left as it was".
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByLabel('Age limit')).toHaveValue('18');
    await page.getByLabel('Age limit').selectOption('');
    await page.getByRole('button', { name: 'Remove artist 1' }).click();
    await page.getByLabel('Terms and conditions').fill('');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect
      .poll(async () => {
        const body = await (
          await request.get(`${API}/events/${draft.eventId}`, { headers: full.auth })
        ).json();
        return [body.ageLimit, body.artists, body.termsAndConditions];
      })
      .toEqual([null, null, null]);
  });
});
