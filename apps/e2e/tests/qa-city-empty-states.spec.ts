import { test, expect, type Page } from '@playwright/test';
import { QA_VALIDATE, QA_SKIP_REASON } from './qa-target';

// Deployment-facing: skipped unless asked for. See qa-target.ts for why.
test.skip(!QA_VALIDATE, QA_SKIP_REASON);

/**
 * What a chosen city does to Browse and Movies, on QA.
 *
 * QA's inventory happens to be split exactly the wrong way for this — the events are in
 * Mumbai and the films are in Bengaluru and Hyderabad — which makes it the ideal place to
 * check it. Picking either city empties one of the two pages, and before this fix the page
 * said "no movies match your search" and left the customer to work out that a filter they
 * set a fortnight ago in the header was the reason.
 */
const CUSTOMER = 'https://customer-web-qa.up.railway.app';

const open = (page: Page, url: string) => page.goto(url, { waitUntil: 'networkidle' });
const cityChip = (page: Page) => page.getByRole('button', { name: /^Location:/ });

/*
  Typed, not picked off a list.

  This used to click the city straight out of the panel, because the panel listed every
  city the platform sells in. It is a search now — it opens on a handful of cities near
  you, and everything else is found by typing — so a test that only clicks would pass or
  fail depending on whether the city it wants happens to be in the shortlist for whatever
  locale the browser reported.
*/
async function chooseCity(page: Page, city: RegExp, term: string) {
  await cityChip(page).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Search for a city').fill(term);
  await dialog.getByRole('option', { name: city }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe('QA: a city that empties a page says so', () => {
  test('Movies names the city and offers the way out', async ({ page }) => {
    await open(page, `${CUSTOMER}/movies`);
    // Mumbai has an event and no films.
    await chooseCity(page, /^Mumbai/, 'mumbai');

    await expect(page.getByText(/No films in Mumbai just yet/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Other places have films showing/)).toBeVisible();

    // One click out, offered here rather than left to be rediscovered in the header.
    await page.getByRole('button', { name: 'Show all cities' }).click();
    await expect(page.getByText(/No films in Mumbai just yet/)).toHaveCount(0);
    await expect(page.locator('a[href^="/movies/"]').first()).toBeVisible({ timeout: 30_000 });
  });

  test('Browse names the city and offers the way out', async ({ page }) => {
    await open(page, `${CUSTOMER}/events`);
    // Bengaluru has films and no browsable events.
    await chooseCity(page, /^Bengaluru/, 'bengaluru');

    await expect(page.getByText(/Nothing on in Bengaluru just yet/)).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Show all cities' }).click();
    await expect(page.getByText(/Nothing on in Bengaluru just yet/)).toHaveCount(0);
  });

  test('a search term makes the message about the search, not the city', async ({ page }) => {
    /*
      The guard on the guard.

      With something typed in the box, the customer already knows why the page is empty and
      a city message would be a red herring. So the city wording only appears when the city
      is the ONLY thing narrowing the results.
    */
    await open(page, `${CUSTOMER}/events`);
    await chooseCity(page, /^Bengaluru/, 'bengaluru');
    await page
      .getByLabel(/Search/i)
      .first()
      .fill('zzzz-no-such-event');
    await page.getByRole('button', { name: /^Search$/ }).click();

    await expect(page.getByText(/No events match your search/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Nothing on in Bengaluru just yet/)).toHaveCount(0);
  });

  test('every film on the shelf can actually be booked', async ({ page, request }) => {
    /*
      The catalogue used to list films whose run had finished and films whose events were
      still drafts — four of seven on QA. A customer taps a poster and lands on a page with
      no showtimes.
    */
    const movies = await (
      await request.get('https://api-qa-f580.up.railway.app/api/public/movies')
    ).json();
    const list = Array.isArray(movies) ? movies : movies.data;
    expect(list.length, 'QA should still have films on sale').toBeGreaterThan(0);

    const deadEnds: string[] = [];
    for (const m of list) {
      const shows = await (
        await request.get(`https://api-qa-f580.up.railway.app/api/public/movies/${m.slug}/shows`)
      ).json();
      if ((shows.shows ?? []).length === 0) deadEnds.push(m.slug);
    }
    expect(deadEnds).toEqual([]);

    // And the catalogue page renders them.
    await open(page, `${CUSTOMER}/movies`);
    await expect(page.locator('a[href^="/movies/"]').first()).toBeVisible({ timeout: 30_000 });
  });
});
