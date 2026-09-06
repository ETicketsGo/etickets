import { test, expect } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * Venues, which had no page at all.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────
 * A venue could be created from the onboarding screen or halfway through the event wizard,
 * and never edited afterwards — yet its name and city print on every listing a customer
 * sees. A typo in a venue name was permanent, and an organizer who moved premises had no
 * way to say so.
 *
 * It is also the organizer's most durable object: events come and go, the hall stays. This
 * walks creating one and correcting it, and checks the correction actually reached the
 * database rather than just the table.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

test.describe('venues', () => {
  test.describe.configure({ mode: 'serial' });

  let owner: Awaited<ReturnType<typeof apiLogin>>;
  let organizationId = '';
  const stamp = Date.now();
  const original = `Rangbhoomi Hall ${stamp}`;
  const corrected = `Rangabhoomi Hall ${stamp}`;

  test.beforeAll(async ({ request }) => {
    // Minted once — the auth throttle is deliberately tight and is not weakened for a test.
    owner = await apiLogin(request, ORGANIZER_EMAIL);
    const orgs = await (
      await request.get(`${API}/organizations`, {
        headers: { Authorization: `Bearer ${owner.accessToken}` },
      })
    ).json();
    organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, owner);
  });

  test('1: venues are reachable from the sidebar, next to Events', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('link', { name: 'Venues' })).toBeVisible({ timeout: 30_000 });
  });

  test('2: a venue can be added, and says what a venue is for', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/venues`, { waitUntil: 'networkidle' });

    /*
      The signpost that stops the confusion this product has already had once: a venue and a
      room with a seating plan are different objects, and somebody hunting for one inside
      the other is how the seat-map feature went undiscovered.
    */
    await expect(page.getByText(/A seating plan belongs to a/)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'New venue' }).click();
    await page.locator('#venueName').fill(original);
    await page.locator('#venueCity').fill('Warangal');
    await page.locator('#venueCapacity').fill('320');
    await page.getByRole('button', { name: 'Add venue' }).click();

    await expect(page.getByRole('cell', { name: new RegExp(original) })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('3: and the typo in its name can be corrected — which was impossible', async ({
    page,
    request,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/venues`, { waitUntil: 'networkidle' });

    const row = page.getByRole('row', { name: new RegExp(original) });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: 'Edit' }).click();

    await page.locator('#venueName').fill(corrected);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Venue updated.')).toBeVisible({ timeout: 30_000 });

    /*
      Checked against the API, not the table. A renamed row proves the component re-rendered;
      what matters is that the name a customer will read on the listing actually changed.
    */
    const venues = await (
      await request.get(`${API}/venues?organizationId=${organizationId}`, {
        headers: { Authorization: `Bearer ${owner.accessToken}` },
      })
    ).json();
    const list = Array.isArray(venues) ? venues : venues.data;
    const saved = list.find((v: { name: string }) => v.name === corrected);
    expect(saved, `expected a venue named ${corrected}`).toBeTruthy();
    // And the edit did not blank the fields the form merely redisplayed.
    expect(saved.city).toBe('Warangal');
    expect(saved.capacity).toBe(320);
  });

  test('4: an empty optional field does not wipe what is already stored', async ({ request }) => {
    /*
      The failure mode a naive edit form has: send '' for every untouched box and an address
      entered months ago is gone. The page sends `undefined` for blanks, so the server leaves
      them alone — asserted through the API because it is a property of the request, not of
      anything visible on screen.
    */
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const created = await (
      await request.post(`${API}/venues`, {
        headers: auth,
        data: {
          organizationId,
          name: `Address Test ${stamp}`,
          city: 'Hyderabad',
          address: '12 Tank Bund Road',
        },
      })
    ).json();

    await request.patch(`${API}/venues/${created.id}`, {
      headers: auth,
      data: { name: `Address Test Renamed ${stamp}` },
    });

    const after = await (
      await request.get(`${API}/venues/${created.id}`, { headers: auth })
    ).json();
    expect(after.name).toBe(`Address Test Renamed ${stamp}`);
    expect(after.address).toBe('12 Tank Bund Road');
  });

  test('5: "Add venue" on the setup checklist opens the form — it used to do nothing', async ({
    page,
  }) => {
    /*
      The reported bug, as a test.

      The checklist's venue step linked to `/organizer/onboarding`, which is the page the
      checklist is ON. Clicking it navigated to where you already were, so nothing happened —
      and a button that appears to do nothing is broken whatever is further down the page.

      Asserted by following the link and finding an OPEN form, not by reading the href: a link
      that points somewhere sensible and lands on a closed dialog is the same dead end.
    */
    await page.goto(`${ORGANIZER}/organizer/onboarding`, { waitUntil: 'networkidle' });

    const cta = page.getByRole('link', { name: /Add venue|Manage venues/ }).first();
    await expect(cta).toBeVisible({ timeout: 30_000 });
    await cta.click();

    await expect(page).toHaveURL(/\/organizer\/venues/, { timeout: 30_000 });
    // Either the form opened (first venue) or the list did (they already have one) — both are
    // somewhere you can act, which is the whole complaint.
    await expect(
      page
        .locator('#venueName')
        .or(page.getByRole('button', { name: 'New venue' }))
        .first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('6: a venue records the state and clock it keeps, which nothing could set before', async ({
    page,
    request,
  }) => {
    /*
      `Venue.region` decides India's place of supply — CGST + SGST within a state, IGST across
      a border — and had no input anywhere in the product, so every venue an organizer created
      left it null and every sale from one looked intra-state. `timezone` was worse: it took
      the schema default of Asia/Kolkata whatever the country, so a show abroad was quoted in
      Indian time on the customer's ticket.

      Checked against the API rather than the form, because what matters is what was STORED.
    */
    const name = `Place Of Supply ${stamp}`;
    await page.goto(`${ORGANIZER}/organizer/venues?new=1`, { waitUntil: 'networkidle' });

    await expect(page.locator('#venueName')).toBeVisible({ timeout: 30_000 });
    await page.locator('#venueName').fill(name);
    await page.locator('#venueCity').fill('Hyderabad');
    await page.locator('#venue-country').selectOption('India');
    await page.locator('#venue-region').selectOption('Telangana');
    await page.getByRole('button', { name: 'Add venue' }).click();
    await expect(page.getByText('Venue added.')).toBeVisible({ timeout: 30_000 });

    const venues = await (
      await request.get(`${API}/venues?organizationId=${organizationId}`, {
        headers: { Authorization: `Bearer ${owner.accessToken}` },
      })
    ).json();
    const saved = (Array.isArray(venues) ? venues : venues.data).find(
      (v: { name: string }) => v.name === name,
    );
    expect(saved).toBeTruthy();
    expect(saved.region).toBe('Telangana');
    expect(saved.country).toBe('India');
    expect(saved.timezone).toBe('Asia/Kolkata');
  });

  test('7: choosing another country changes what it asks for, and the clock it offers', async ({
    page,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/venues?new=1`, { waitUntil: 'networkidle' });
    await expect(page.locator('#venue-country')).toBeVisible({ timeout: 30_000 });

    // India has one zone, so there is nothing to ask.
    await page.locator('#venue-country').selectOption('India');
    await expect(page.locator('#venue-timezone')).toHaveCount(0);

    /*
      The United States has seven, and the country cannot decide between them — which is
      exactly why leaving the venue on Asia/Kolkata was wrong rather than merely imprecise.
    */
    await page.locator('#venue-country').selectOption('United States');
    await expect(page.locator('#venue-timezone')).toBeVisible();
    await expect(page.locator('#venue-timezone')).toHaveValue('America/New_York');
    await expect(page.locator('#venue-region')).toBeVisible();
    // And it asks for a state, not a "province" or an "emirate".
    await expect(page.getByText('State', { exact: true })).toBeVisible();

    // Singapore has no subdivision in an address, so the field is absent rather than empty.
    await page.locator('#venue-country').selectOption('Singapore');
    await expect(page.locator('#venue-region')).toHaveCount(0);
  });
});
