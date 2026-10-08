import { test, expect } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * A space is inside a venue, so it is where the venue is.
 *
 * ── THE DEFECT THIS LOCKS SHUT ─────────────────────────────────────────────────────
 * Creating a space asked for City, Street address, Latitude and Longitude, and THEN asked
 * which venue it was in. An organizer entered a location, then named the venue that already
 * had one, and nothing reconciled the two. That is why a space inside a venue could appear
 * to be somewhere else on a public listing: it genuinely carried its own address, and
 * nothing said which of the two won.
 *
 * The fix is structural rather than a better label - the venue is chosen FIRST, and its
 * location is then SHOWN rather than asked for a second time. These assertions are the
 * contract: ask for a location twice again and this fails.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

test.describe('a space takes its location from its venue', () => {
  let owner: Awaited<ReturnType<typeof apiLogin>>;

  test.beforeAll(async ({ request }) => {
    // Minted once: the auth throttle counts requests, not logins, and is not weakened here.
    owner = await apiLogin(request, ORGANIZER_EMAIL);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, owner);
  });

  test('the venue is asked for first, and then decides the location', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/cinemas/new`);
    await expect(page.locator('#venueId')).toBeVisible();

    /*
      Order matters, and is asserted rather than assumed: the venue question must come
      before the name, because it is what the rest of the form depends on.
    */
    const venueBox = await page.locator('#venueId').boundingBox();
    const nameBox = await page.locator('#name').boundingBox();
    expect(venueBox!.y, 'the venue is chosen before the space is named').toBeLessThan(nameBox!.y);

    const options = page.locator('#venueId option');
    const count = await options.count();
    test.skip(count < 2, 'no existing venue to attach a space to');

    await page.selectOption('#venueId', (await options.nth(1).getAttribute('value'))!);

    // The location is now STATED, with the venue named as its source.
    await expect(page.getByText(/inherited from the venue/i)).toBeVisible();

    /*
      And not asked again. A second address box is the whole defect - it is the thing that
      let the two disagree - so its absence is the assertion, not the tidy layout around it.
    */
    await expect(page.locator('#city')).toHaveCount(0);
    await expect(page.locator('#venue-city')).toHaveCount(0);
    await expect(page.locator('#address')).toHaveCount(0);
  });

  test('a new venue still asks for the location, because nothing else knows it', async ({
    page,
  }) => {
    // The other half of the rule: inheriting is right only when there is something to
    // inherit from. Choosing to create a venue must still collect where it is.
    await page.goto(`${ORGANIZER}/organizer/cinemas/new`);
    await page.selectOption('#venueId', '');
    await expect(page.locator('#city')).toBeVisible();
  });

  test('the console calls the thing one name', async ({ page }) => {
    /*
      "Rooms" and "spaces" were both on screen at once - the sidebar said one, the page it
      opened said the other. One word, checked on the pages an organizer actually crosses.
    */
    for (const path of ['/organizer/venues', '/organizer/cinemas', '/organizer/cinemas/new']) {
      await page.goto(`${ORGANIZER}${path}`);
      await expect(page.getByRole('link', { name: 'Venues & spaces' }).first()).toBeVisible();
      const body = await page.locator('body').innerText();
      expect(body, `${path} still says "room" to the organizer`).not.toMatch(/\brooms?\b/i);
    }
  });

  test('the venue a space was created in is the venue the API stores', async ({ request }) => {
    /*
      The screen can show the right thing and still send the wrong thing. This reads the
      space back from the API, because that row is what a customer's listing is built from.
    */
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    // `/venues` is scoped to an organization and refuses without one, so ask for the org first.
    const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
    const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
    const venuesRes = await request.get(`${API}/venues?organizationId=${organizationId}`, {
      headers: auth,
    });
    expect(venuesRes.ok(), await venuesRes.text()).toBeTruthy();
    const venues = await venuesRes.json();
    const list = Array.isArray(venues) ? venues : venues.data;
    expect(list?.length, 'the seed must provide a venue for this to mean anything').toBeGreaterThan(
      0,
    );
    const venue = list[0];

    const created = await request.post(`${API}/cinemas`, {
      headers: auth,
      // The organization goes in the BODY on create and the QUERY on list - the controller
      // takes it each way, so the two calls below are not symmetrical by mistake.
      data: { organizationId, name: `Hall ${Date.now()}`, venueId: venue.id, city: venue.city },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const space = await created.json();

    const read = await (await request.get(`${API}/cinemas/${space.id}`, { headers: auth })).json();
    expect(read.venue?.id ?? read.venueId).toBe(venue.id);
    expect(read.city, 'the space must not sit in a different city from its venue').toBe(venue.city);
  });
});
