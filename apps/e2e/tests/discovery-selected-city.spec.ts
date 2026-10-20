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

    /*
      The owner removed the "More in <country>" and "Elsewhere: <country>" rails (2026-10-19,
      "do we really need Elsewhere part?"). This test used to assert their order and currency
      notes; it now asserts that a page shows only the place the visitor chose.
    */
    test('a selected city shows that city alone: no "More in" and no "Elsewhere" groups', async ({
      page,
    }) => {
      await mockCatalogue(page);
      await select(page, 'Mumbai', 'IN');
      for (const path of ['/', '/explore', '/events']) {
        await page.goto(`${CUSTOMER}${path}`, { waitUntil: 'networkidle' });
        await expect(chip(page)).toHaveAccessibleName('Location: Mumbai. Change');
        await expect(page.locator('main')).toContainText('Show mum1');
        await expect(page.locator('[data-place-group]')).toHaveCount(0);
        const main = page.locator('main');
        await expect(main).not.toContainText(/Elsewhere|More in India/);
        // Not the rest of India, not the United States, not Canada.
        for (const other of ['Show hyd1', 'Show boi1', 'Show tor1']) {
          await expect(main).not.toContainText(other);
        }
      }
    });

    test('"All cities" is one list of the country: no "Elsewhere" groups', async ({ page }) => {
      await mockCatalogue(page);
      await select(page, '__all__', 'IN');
      await page.goto(`${CUSTOMER}/events`, { waitUntil: 'networkidle' });
      const main = page.locator('main');
      await expect(main).toContainText('Show mum1');
      await expect(main).toContainText('Show hyd1');
      await expect(page.locator('[data-place-group]')).toHaveCount(0);
      await expect(main).not.toContainText(/Elsewhere|Prices in/);
      await expect(main).not.toContainText('Show boi1');
      await expect(main).not.toContainText('Show tor1');
    });

    test('a city with nothing on says so, suggests cities in its country, and shows nothing from elsewhere', async ({
      page,
    }) => {
      await mockCatalogue(page);
      await select(page, 'Pune', 'IN');
      for (const path of ['/', '/explore', '/events']) {
        await page.goto(`${CUSTOMER}${path}`, { waitUntil: 'networkidle' });
        await expect(page.getByText('No events available in Pune yet').first()).toBeVisible();
        await expect(chip(page)).toHaveAccessibleName('Location: Pune. Change');
        // Was: "Elsewhere: United States" and "Elsewhere: Canada" visible under the empty state.
        await expect(page.locator('[data-place-group]')).toHaveCount(0);
        await expect(page.locator('main')).not.toContainText(/Elsewhere/);
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

test('a stored city does not cause a hydration mismatch (React #418)', async ({ page }) => {
  // The city used to be read from localStorage while rendering, so the first client render
  // differed from the server's. Storage is now read after hydration.
  await mockCatalogue(page);
  await select(page, 'Mumbai', 'IN');
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /418|hydrat/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => {
    if (/418|hydrat/i.test(String(e))) problems.push(String(e));
  });
  for (const path of ['/movies', '/events?q=show', '/']) {
    await page.goto(`${CUSTOMER}${path}`, { waitUntil: 'networkidle' });
    await expect(chip(page)).toHaveAccessibleName('Location: Mumbai. Change');
  }
  expect(problems).toEqual([]);
});
