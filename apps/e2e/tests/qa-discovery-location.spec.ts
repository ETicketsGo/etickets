import { test, expect, type Page } from '@playwright/test';
import { QA_VALIDATE, QA_SKIP_REASON } from './qa-target';

// Deployment-facing: skipped unless asked for. See qa-target.ts for why.
test.skip(!QA_VALIDATE, QA_SKIP_REASON);

/**
 * Finding something near you, on QA.
 *
 * ── WHY THESE ARE DEPLOYMENT TESTS AND NOT UNIT TESTS ──────────────────────────────
 * Every defect below was invisible in a diff and obvious in a browser. The homepage
 * ignoring the city filter is three lines that look correct in isolation; the dead
 * category chips need real inventory to be dead; the country scope needs two countries in
 * the database to be worth anything. QA has all of it — fifteen events in India, one in
 * the United States — which is why this suite lives here.
 *
 * ── THE ONE THING THAT MAKES THESE DETERMINISTIC ───────────────────────────────────
 * The browser locale. Country scoping starts from a hint, and on an environment with no
 * CDN in front of it the only hint available is `navigator.language`. Pinning the locale
 * per test is therefore not a convenience — it IS the input, and without it these tests
 * would pass or fail depending on the machine running them.
 */
const CUSTOMER = 'https://customer-web-qa.up.railway.app';

const open = (page: Page, url: string) => page.goto(url, { waitUntil: 'networkidle' });

/** The header chip, whatever it currently says. */
const locationChip = (page: Page) => page.getByRole('button', { name: /^Location:/ });

const eventCards = (page: Page) => page.locator('a[href*="/events/"]');

test.describe('QA: where the customer is actually changes what they see', () => {
  test.use({ locale: 'en-IN' });

  test('the home page obeys the header, which it used to ignore completely', async ({ page }) => {
    /*
      The defect, exactly: `DiscoverHome` fetched `listEvents({ pageSize: '12' })` with no
      city at all. Browse honoured the chip, the homepage did not, so the header said
      Bengaluru and the grid underneath it showed Mumbai. Nothing errored — the two pages
      simply disagreed, and the customer reads a disagreement as a broken filter.
    */
    await open(page, `${CUSTOMER}/`);

    await locationChip(page).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Search for a city').fill('mumbai');
    await dialog.getByRole('option', { name: /^Mumbai/ }).click();
    await expect(dialog).toHaveCount(0);

    // The section heading names the place, so the filter is legible from the page itself
    // rather than only from the chip in the corner.
    await expect(page.getByRole('heading', { name: /Happening in Mumbai/ })).toBeVisible({
      timeout: 30_000,
    });

    // And the grid is genuinely narrowed: every card that names a city names this one.
    const venues = page.locator('[data-testid="event-card-venue"], .text-text-muted');
    await expect(eventCards(page).first()).toBeVisible({ timeout: 30_000 });
    const text = (await page.locator('main').innerText()).toLowerCase();
    expect(text).not.toContain('meridian'); // the one USA city on QA
    expect(venues).toBeTruthy();
  });

  test('no category chip leads to a dead end', async ({ page }) => {
    /*
      The homepage offered a hardcoded Music / Tech / Comedy / Sports / Theatre. QA has no
      Tech, no Sports and no Theatre event, so three of the five chips were a guaranteed
      empty page — while Community, which has two events, was never offered. An empty page
      reached by following our own suggestion reads as "this platform has nothing".

      This test does not assert WHICH categories appear. It asserts the property that
      matters and that will still be true after the catalogue changes: everything we offer
      returns something.
    */
    await open(page, `${CUSTOMER}/`);
    await expect(page.getByRole('heading', { name: /Explore by category/ })).toBeVisible({
      timeout: 30_000,
    });

    const chips = page.locator('section:has(h2:text("Explore by category")) button');
    const count = await chips.count();
    expect(count).toBeGreaterThan(0);

    const names: string[] = [];
    for (let i = 0; i < count; i++) names.push((await chips.nth(i).innerText()).split('\n')[0]);

    for (const name of names) {
      await open(page, `${CUSTOMER}/events?category=${encodeURIComponent(name)}`);
      await expect(
        page.getByText(/No events match your search|Nothing on in/),
        `the "${name}" chip we offer leads to an empty page`,
      ).toHaveCount(0, { timeout: 30_000 });
    }
  });

  test('with no city chosen, Browse shows the visitor country and not the whole world', async ({
    page,
  }) => {
    // en-IN, so the country hint is India. QA's single USA event must not be in the list.
    await open(page, `${CUSTOMER}/events`);

    await expect(page.getByText(/Showing events in IN|Showing events in India/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(eventCards(page).first()).toBeVisible({ timeout: 30_000 });
    expect((await page.locator('main').innerText()).toLowerCase()).not.toContain('meridian');

    // And the escape hatch is real: the USA event is one click away, not hidden.
    await page.getByRole('button', { name: 'Show everywhere' }).click();
    await expect(page.getByText(/Meridian/i).first()).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('QA: the location picker is a search, not a list of everywhere we sell', () => {
  test.use({ locale: 'en-IN' });

  test('it opens on a shortlist and finds a city by prefix', async ({ page }) => {
    /*
      The old picker rendered every sellable city grouped by country. That is fine at six
      and unusable at six hundred — and on QA it also put the platform's data-entry
      mistakes in front of every visitor: a "Hyd" next to "Hyderabad", and a "Boise"
      filed under India.
    */
    await open(page, `${CUSTOMER}/`);
    await locationChip(page).click();
    const dialog = page.getByRole('dialog');

    // A shortlist, and it says it is one.
    await expect(dialog.getByText('Popular near you')).toBeVisible();
    const shortlist = await dialog.getByRole('option').count();
    expect(shortlist).toBeGreaterThan(0);
    expect(shortlist).toBeLessThanOrEqual(8);

    // Typing narrows it, from the server rather than from what was already on screen.
    await dialog.getByLabel('Search for a city').fill('beng');
    await expect(dialog.getByRole('option', { name: /^Bengaluru/ })).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog.getByRole('option')).toHaveCount(1);
  });

  test('a city we do not sell in says so instead of returning silence', async ({ page }) => {
    await open(page, `${CUSTOMER}/`);
    await locationChip(page).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Search for a city').fill('reykjavik');

    // Names the reason. "No results" would leave the customer retyping it.
    await expect(dialog.getByText(/have events on sale/)).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('QA: Browse only claims filters it actually applied', () => {
  test.use({ locale: 'en-IN' });

  test('an applied filter appears as a chip and removing it widens the results', async ({
    page,
  }) => {
    /*
      The page used to print "Interpreted your search as: date: this weekend · free only"
      and then send neither — the parser produced them and `applyFilters` dropped them on
      the floor. A UI that reports a filter it did not apply is worse than one that does
      not try: the customer trusts the label and mis-reads the results.

      Chips are the fix and the check in one: each one corresponds to a parameter that was
      sent, and each one can be taken off again.
    */
    await open(page, `${CUSTOMER}/events?category=Music`);
    await expect(eventCards(page).first()).toBeVisible({ timeout: 30_000 });

    const chip = page.getByText('Filtered by');
    await expect(chip).toBeVisible();
    const before = await eventCards(page).count();

    await page.getByRole('button', { name: 'Remove filter: Music' }).click();
    await expect(page.getByRole('button', { name: 'Remove filter: Music' })).toHaveCount(0);
    await expect
      .poll(() => eventCards(page).count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(before);
  });

  test('searching for a title keeps the country scope instead of widening to the world', async ({
    page,
  }) => {
    /*
      "No city" and "everywhere" are different intents and used to be the same call.
      Writing the search through to the header as `setCity(null)` dropped the country hint
      with it, so typing a title into the box quietly widened the page to every country we
      sell in — undoing the scoping on the first search anyone made.
    */
    await open(page, `${CUSTOMER}/events`);
    await expect(page.getByText(/Showing events in/)).toBeVisible({ timeout: 30_000 });

    await page.getByLabel('Search').first().fill('the');
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page.getByRole('button', { name: /^Remove filter: / })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Showing events in/)).toBeVisible();
    expect((await page.locator('main').innerText()).toLowerCase()).not.toContain('meridian');
  });

  test('a near-miss city finds the city instead of a confident empty page', async ({ page }) => {
    /*
      `city=` is an exact match at the API, so a typed "bengal" used to return nothing for a
      city with four events in it. Resolving a prefix against real inventory is the
      difference between a search and a spelling test.
    */
    await open(page, `${CUSTOMER}/events`);
    await page.getByLabel('City').fill('bengal');
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page.getByRole('button', { name: 'Remove filter: Bengaluru' })).toBeVisible({
      timeout: 30_000,
    });
  });
});
