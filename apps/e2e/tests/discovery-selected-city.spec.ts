import { test, expect, type Page } from '@playwright/test';
import { API, CUSTOMER } from './helpers';

/**
 * Discovery follows the customer's SELECTED city.
 *
 * Runs against a mocked catalogue on purpose: the seeded database has one country, and these
 * rules are about three (India, the United States, Canada) and about spellings ("India" and "IN")
 * that a real seed would have to be corrupted to contain. The browser, the picker, the header
 * and every page are real; only `/public/*` answers are canned.
 */

type Ev = { id: string; city: string; country: string; code: string; currency: string; tz: string };
const EVENTS: Ev[] = [
  { id: 'mum1', city: 'Mumbai', country: 'India', code: 'IN', currency: 'INR', tz: 'Asia/Kolkata' },
  {
    id: 'hyd1',
    city: 'Hyderabad',
    country: 'India',
    code: 'IN',
    currency: 'INR',
    tz: 'Asia/Kolkata',
  },
  { id: 'hyd2', city: 'Hyderabad', country: 'IN', code: 'IN', currency: 'INR', tz: 'Asia/Kolkata' },
  {
    id: 'boi1',
    city: 'Boise',
    country: 'United States',
    code: 'US',
    currency: 'USD',
    tz: 'America/Boise',
  },
  {
    id: 'tor1',
    city: 'Toronto',
    country: 'Canada',
    code: 'CA',
    currency: 'CAD',
    tz: 'America/Toronto',
  },
];

const card = (e: Ev) => ({
  id: e.id,
  title: `Show ${e.id}`,
  slug: `show-${e.id}`,
  category: 'Music',
  venue: {
    name: `${e.city} Hall`,
    city: e.city,
    country: e.country,
    countryCode: e.code,
    timezone: e.tz,
  },
  organizer: 'Org',
  nextSessionAt: '2030-01-01T14:00:00.000Z',
  fromPriceMinor: 50000,
  currency: e.currency,
});

const CITIES = [
  { city: 'Hyderabad', country: 'India', countryCode: 'IN', eventCount: 2 },
  // An older API's duplicate spelling of the same city: the picker must still list it once.
  { city: 'Hyderabad', country: 'IN', eventCount: 1 },
  { city: 'Mumbai', country: 'India', countryCode: 'IN', eventCount: 1 },
  { city: 'Boise', country: 'United States', countryCode: 'US', eventCount: 1 },
  { city: 'Toronto', country: 'Canada', countryCode: 'CA', eventCount: 1 },
];

async function mockCatalogue(page: Page) {
  await page.route('**/api/public/location/resolve*', (r) =>
    r.fulfill({
      json: {
        country: 'IN',
        city: null,
        region: null,
        source: 'network',
        confident: false,
        scopeCountry: 'IN',
        topCities: [],
      },
    }),
  );
  await page.route('**/api/public/location/cities*', (r) => r.fulfill({ json: CITIES }));
  await page.route('**/api/public/categories*', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/public/movies*', (r) => r.fulfill({ json: [] }));
  await page.route(/\/api\/public\/events(\?.*)?$/, (r) => {
    const p = new URL(r.request().url()).searchParams;
    let list = EVENTS;
    if (p.get('city')) {
      list = list.filter((e) => e.city.toLowerCase() === p.get('city')!.toLowerCase());
    } else if (p.get('country')) {
      list = list.filter((e) => e.code === p.get('country') || e.country === p.get('country'));
    }
    if (p.get('excludeCity')) list = list.filter((e) => e.city !== p.get('excludeCity'));
    r.fulfill({
      json: {
        data: list.map(card),
        meta: { page: 1, pageSize: 24, total: list.length, totalPages: 1 },
      },
    });
  });
  await page.route('**/api/public/events/show-*', (r) => r.fulfill({ status: 404, json: {} }));
}

const chip = (page: Page) => page.getByRole('button', { name: /^Location:/ });

async function select(page: Page, city: string, country: string) {
  await page.addInitScript(
    ([c, k]) =>
      localStorage.setItem('etg.city', JSON.stringify({ city: c, region: null, country: k })),
    [city, country],
  );
}

for (const width of [1440, 390]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the selected city survives every page and a search; the picker lists each city once', async ({
      page,
    }) => {
      await mockCatalogue(page);
      await select(page, 'Mumbai', 'IN');
      for (const path of ['/', '/explore', '/movies', '/events']) {
        await page.goto(`${CUSTOMER}${path}`, { waitUntil: 'networkidle' });
        await expect(chip(page)).toHaveAccessibleName('Location: Mumbai. Change');
      }
      // A search on Browse must not write to the header, nor drop it to a country.
      await page.getByLabel('Search').first().fill('show');
      await page.keyboard.press('Enter');
      await expect(page.getByText('Filtered by')).toBeVisible();
      await expect(chip(page)).toHaveAccessibleName('Location: Mumbai. Change');
      await expect(page.getByRole('banner')).not.toContainText(/United/);

      await chip(page).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('group', { name: 'India' })).toBeVisible();
      await expect(dialog.getByRole('group', { name: 'United States' })).toBeVisible();
      await expect(dialog.getByRole('group', { name: 'Canada' })).toBeVisible();
      await expect(dialog.getByRole('option', { name: /^Hyderabad/ })).toHaveCount(1);
    });

    test('home orders the selected city, its country, then each other country in its own currency', async ({
      page,
    }) => {
      await mockCatalogue(page);
      await select(page, 'Mumbai', 'IN');
      await page.goto(`${CUSTOMER}/`, { waitUntil: 'networkidle' });
      const same = page.locator('[data-place-group="same-country"]');
      const us = page.locator('[data-place-group="elsewhere"][data-country="US"]');
      const ca = page.locator('[data-place-group="elsewhere"][data-country="CA"]');
      await expect(same).toContainText('More in India');
      await expect(same).toContainText('Hyderabad');
      await expect(us).toContainText('Elsewhere: United States');
      await expect(us).toContainText('Boise');
      await expect(us).toContainText('USD');
      await expect(ca).toContainText('Elsewhere: Canada');
      await expect(ca).toContainText('Toronto');
      await expect(ca).toContainText('CAD');
      // Document order: its country, then the United States, then Canada.
      const y = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!.y;
      expect(await y(same)).toBeLessThan(await y(us));
      expect(await y(us)).toBeLessThan(await y(ca));
      // India is never offered as "elsewhere" to a visitor in India.
      await expect(page.locator('[data-place-group="elsewhere"][data-country="IN"]')).toHaveCount(
        0,
      );
    });

    test('a city with nothing on says so, suggests cities in its country, and still shows the rest', async ({
      page,
    }) => {
      await mockCatalogue(page);
      await select(page, 'Pune', 'IN');
      for (const path of ['/', '/explore', '/events']) {
        await page.goto(`${CUSTOMER}${path}`, { waitUntil: 'networkidle' });
        await expect(page.getByText('No events available in Pune yet').first()).toBeVisible();
        await expect(chip(page)).toHaveAccessibleName('Location: Pune. Change');
        await expect(page.getByText('Elsewhere: United States').first()).toBeVisible();
        await expect(page.getByText('Elsewhere: Canada').first()).toBeVisible();
      }
      await page.goto(`${CUSTOMER}/events`, { waitUntil: 'networkidle' });
      await expect(page.getByRole('button', { name: /Mumbai/ }).first()).toBeVisible();
    });
  });
}

test.describe('an event page never scrolls sideways', () => {
  test.use({ viewport: { width: 320, height: 800 } });

  test('at 320px the venue and support panels fit the column', async ({ page, request }) => {
    // Real events, real API: the overflow came from panel content, not from a mocked shape.
    const listed = await request.get(`${API}/public/events?pageSize=3`);
    const slugs: string[] = ((await listed.json()).data ?? []).map((e: { slug: string }) => e.slug);
    test.skip(slugs.length === 0, 'no published events to open');
    for (const slug of slugs) {
      await page.goto(`${CUSTOMER}/events/${slug}`, { waitUntil: 'networkidle' });
      const [scroll, client] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(scroll, `${slug} overflows by ${scroll - client}px`).toBeLessThanOrEqual(client);
    }
  });
});
