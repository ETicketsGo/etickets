import { test, expect, type Page } from '@playwright/test';
import { CUSTOMER } from './helpers';

/**
 * "Use my current location" names where the person IS, whatever we sell there.
 *
 * It used to answer from inventory - the nearest cinema with coordinates and something on
 * sale - so Dallas, Hyderabad and Vijayawada all came back with no city and the page fell back
 * to a country. These drive the real browser geolocation and the real picker.
 *
 * The local seed has events in Boise (the demo venues) and in Hyderabad's cinemas only through
 * seed data that may or may not be on sale, so the "no events" cities below are ones the seed
 * never touches: Dallas and Vijayawada.
 */

const chip = (page: Page) => page.getByRole('button', { name: /^Location:/ });

async function useMyLocation(page: Page, at: { latitude: number; longitude: number }) {
  await page.context().grantPermissions(['geolocation'], { origin: CUSTOMER });
  await page.context().setGeolocation(at);
  await chip(page).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Use my current location' }).click();
}

for (const width of [1440, 390]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('Dallas, with nothing on sale, is still Dallas - and says so', async ({ page }) => {
      await page.goto(`${CUSTOMER}/`, { waitUntil: 'networkidle' });
      await useMyLocation(page, { latitude: 32.7767, longitude: -96.797 });
      await expect(chip(page)).toHaveAccessibleName(/Location: Dallas/, { timeout: 15_000 });
      await expect(page.getByText(/No events available in Dallas yet/)).toBeVisible({
        timeout: 15_000,
      });
    });

    test('Vijayawada, with nothing on sale, is still Vijayawada', async ({ page }) => {
      await page.goto(`${CUSTOMER}/`, { waitUntil: 'networkidle' });
      await useMyLocation(page, { latitude: 16.5062, longitude: 80.648 });
      await expect(chip(page)).toHaveAccessibleName(/Location: Vijayawada/, { timeout: 15_000 });
      await expect(page.getByText(/No events available in Vijayawada yet/)).toBeVisible({
        timeout: 15_000,
      });
    });
  });
}

test('a city with events shows that city and its events', async ({ page }) => {
  // Boise holds the seeded demo venues (arena, theater, concert hall).
  await page.goto(`${CUSTOMER}/`, { waitUntil: 'networkidle' });
  await useMyLocation(page, { latitude: 43.615, longitude: -116.2023 });
  await expect(chip(page)).toHaveAccessibleName(/Location: Boise/, { timeout: 15_000 });
  await expect(page.getByText(/No events available in Boise yet/)).toHaveCount(0);
  await expect(page.getByText(/Demo Arena|Riverbend|Old Mill/).first()).toBeVisible({
    timeout: 15_000,
  });
});

test('permission denied explains itself and leaves the search box ready', async ({ page }) => {
  await page.goto(`${CUSTOMER}/`, { waitUntil: 'networkidle' });
  await page.context().clearPermissions();
  await chip(page).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Use my current location' }).click();
  await expect(dialog.getByText(/Location is off or blocked for this site/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog.getByLabel('Search for a city')).toBeVisible();
  // Nothing was invented: the chip does not name a city we never resolved.
  await expect(chip(page)).not.toHaveAccessibleName(/Location: (Dallas|Hyderabad|Boise)/);
});

test('a city chosen by hand survives a refresh, and is not overwritten', async ({ page }) => {
  await page.goto(`${CUSTOMER}/`, { waitUntil: 'networkidle' });
  await chip(page).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Search for a city').fill('boise');
  await dialog.getByRole('option', { name: /^Boise/ }).click();
  await expect(chip(page)).toHaveAccessibleName(/Location: Boise/);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(chip(page)).toHaveAccessibleName(/Location: Boise/, { timeout: 15_000 });
});

test('moving countries leaves no stale city behind', async ({ page }) => {
  // Located in Dallas, then a city in India chosen by hand: the page is that city, in India,
  // with nothing left over from the United States.
  await page.goto(`${CUSTOMER}/`, { waitUntil: 'networkidle' });
  await useMyLocation(page, { latitude: 32.7767, longitude: -96.797 });
  await expect(chip(page)).toHaveAccessibleName(/Location: Dallas/, { timeout: 15_000 });
  await chip(page).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Search for a city').fill('hyderabad');
  await dialog.getByRole('option', { name: /^Hyderabad/ }).click();
  await expect(chip(page)).toHaveAccessibleName(/Location: Hyderabad/);
  await expect(page.getByText(/No events available in Dallas yet/)).toHaveCount(0);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(chip(page)).toHaveAccessibleName(/Location: Hyderabad/, { timeout: 15_000 });
  const stored = await page.evaluate(() => localStorage.getItem('etg.city'));
  expect(JSON.parse(stored ?? '{}')).toMatchObject({ city: 'Hyderabad', country: 'India' });
});
