import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { QA_VALIDATE, QA_SKIP_REASON } from './qa-target';
import { apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

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

/*
  Why these sign in.

  `/` is adaptive: a signed-out visitor gets the marketing shell, and a signed-in one gets
  the discovery app — which is the only place the header's location chip exists. The first
  run of this suite failed four tests waiting for a chip that is not on the marketing page,
  which is the test being wrong rather than the app. Discovery is a signed-in surface here,
  so the tests sign in.

  One login for the whole file, seeded straight into localStorage: the API throttles
  credential requests at ten a minute, and eight tests each logging in would trip it and
  fail for a reason that has nothing to do with what is being tested.
*/
let tokens: AuthTokens;

test.beforeAll(async ({ request }) => {
  test.skip(!QA_VALIDATE, QA_SKIP_REASON);
  tokens = await apiLogin(request, 'customer1@eticketsgo.test');
});

async function openApp(page: Page, context: BrowserContext, path: string) {
  await seedBrowserAuth(context, tokens);
  await page.goto(`${CUSTOMER}${path}`, { waitUntil: 'networkidle' });
}

const open = (page: Page, url: string) => page.goto(url, { waitUntil: 'networkidle' });

/** The header chip, whatever it currently says. */
const locationChip = (page: Page) => page.getByRole('button', { name: /^Location:/ });

const eventCards = (page: Page) => page.locator('a[href*="/events/"]');

test.describe('QA: where the customer is actually changes what they see', () => {
  test.use({ locale: 'en-IN' });

  test('the home page obeys the header, which it used to ignore completely', async ({
    page,
    context,
  }) => {
    /*
      The defect, exactly: `DiscoverHome` fetched `listEvents({ pageSize: '12' })` with no
      city at all. Browse honoured the chip, the homepage did not, so the header said
      Bengaluru and the grid underneath it showed Mumbai. Nothing errored — the two pages
      simply disagreed, and the customer reads a disagreement as a broken filter.
    */
    await openApp(page, context, '/');

    await locationChip(page).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Search for a city').fill('mumbai');
    await dialog.getByRole('option', { name: /^Mumbai/ }).click();
    await expect(dialog).toHaveCount(0);

    // The section heading names the place, so the filter is legible from the page itself
    // rather than only from the chip in the corner.
    await expect(page.getByRole('heading', { name: /Coming up in Mumbai/ })).toBeVisible({
      timeout: 30_000,
    });

    // And the city's own list is genuinely narrowed; Boise is QA's US city. The "Elsewhere:"
    // groups (#363) were removed on 2026-10-19, so the split below keeps the whole page.
    await expect(eventCards(page).first()).toBeVisible({ timeout: 30_000 });
    const text = (await page.locator('main').innerText()).toLowerCase();
    expect(text.split('elsewhere:')[0]).not.toContain('boise');
  });

  test('no category chip leads to a dead end', async ({ page, context }) => {
    /*
      The homepage offered a hardcoded Music / Tech / Comedy / Sports / Theatre. QA has no
      Tech, no Sports and no Theatre event, so three of the five chips were a guaranteed
      empty page — while Community, which has two events, was never offered. An empty page
      reached by following our own suggestion reads as "this platform has nothing".

      This test does not assert WHICH categories appear. It asserts the property that
      matters and that will still be true after the catalogue changes: everything we offer
      returns something.
    */
    /*
      Since the redesign (#354) the homepage offers the kinds as chips that filter in place,
      in the group "Choose a day or a kind of event". The day chips and Movies (a link to the
      film shelf) are not kinds of event and are left out.
    */
    await openApp(page, context, '/');
    const group = page.getByRole('group', { name: 'Choose a day or a kind of event' });
    await expect(group).toBeVisible({ timeout: 30_000 });

    const names = (await group.getByRole('button').allInnerTexts())
      .map((t) => t.split('\n')[0].trim())
      .filter((t) => t && !/^(All|Today|This weekend|Movies)$/i.test(t));
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      await group.getByRole('button', { name, exact: true }).click();
      await expect(
        page.getByText(/Nothing matches this filter/),
        `the "${name}" chip we offer leads to an empty result`,
      ).toHaveCount(0, { timeout: 30_000 });
    }
  });

  test('with no city chosen, Browse shows the visitor country and not the whole world', async ({
    page,
  }) => {
    // en-IN, so the country hint is India. QA's US events (Boise) must not be in India's list.
    await open(page, `${CUSTOMER}/events`);

    await expect(page.getByText(/Showing events in IN|Showing events in India/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(eventCards(page).first()).toBeVisible({ timeout: 30_000 });
    const text = (await page.locator('main').innerText()).toLowerCase();
    expect(text.split('elsewhere:')[0]).not.toContain('boise');

    // The way out is named rather than dumped: "Change location" opens the picker. (Other
    // countries no longer follow under an "Elsewhere:" heading - removed 2026-10-19.)
    await page.getByRole('button', { name: 'Change location' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('QA: the location picker is a search, not a list of everywhere we sell', () => {
  test.use({ locale: 'en-IN' });

  test('it opens on a shortlist and finds a city by prefix', async ({ page, context }) => {
    /*
      The old picker rendered every sellable city grouped by country. That is fine at six
      and unusable at six hundred — and on QA it also put the platform's data-entry
      mistakes in front of every visitor: a "Hyd" next to "Hyderabad", and a "Boise"
      filed under India.
    */
    await openApp(page, context, '/');
    await locationChip(page).click();
    const dialog = page.getByRole('dialog');

    // The catalogue, grouped by country: every city we sell in, each once.
    await expect(dialog.getByRole('group', { name: 'India' })).toBeVisible();
    expect(await dialog.getByRole('option').count()).toBeGreaterThan(0);

    // Typing narrows it, from the server rather than from what was already on screen.
    await dialog.getByLabel('Search for a city').fill('beng');
    await expect(dialog.getByRole('option', { name: /^Bengaluru/ })).toBeVisible({
      timeout: 15_000,
    });
    // The sellable city leads; real places with nothing on sale may follow it.
    await expect(dialog.getByRole('option').first()).toHaveAccessibleName(/^Bengaluru/);
  });

  test('a city we do not sell in can still be chosen, and says it has nothing yet', async ({
    page,
    context,
  }) => {
    await openApp(page, context, '/');
    await locationChip(page).click();
    const dialog = page.getByRole('dialog');
    // Discovery covers India, the US and Canada (#363), so the example is a city in those
    // countries where QA sells nothing: Pune.
    await dialog.getByLabel('Search for a city').fill('pune');

    // Found, and honest about it: the customer's own city is never missing from the list.
    const option = dialog.getByRole('option', { name: /^Pune/ });
    await expect(option).toBeVisible({ timeout: 15_000 });
    await expect(option).toContainText('No events yet');
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
