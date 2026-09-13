import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, CUSTOMER } from './helpers';

/**
 * The film page's showtime picker: a date strip, client-side filters, and pills that are links
 * only when a ticket can be bought.
 *
 * Fixtures are discovered from the live API, never assumed. The seeded film is tried first, but
 * any published film with the shape a test needs will do, so the suite survives the seed growing.
 * Pills carry `data-*` attributes (availability, format, time of day) so assertions read state
 * rather than parsing words that change with the locale.
 */

const SEEDED = 'skyfront-protocol';

interface ShowRow {
  sessionId: string;
  availability: 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'SALES_PAUSED';
  format: string | null;
  localDate: string | null;
  startsAt: string;
}

interface ShowsResponse {
  shows: ShowRow[];
  filters: { formats: string[] };
}

async function showsFor(request: APIRequestContext, slug: string): Promise<ShowsResponse> {
  return (await request.get(`${API}/public/movies/${slug}/shows?limit=200`)).json();
}

/** The first published film, seeded one first, whose showtimes satisfy `wanted`. */
async function findFilm(
  request: APIRequestContext,
  wanted: (shows: ShowsResponse) => boolean,
): Promise<string | null> {
  const listed = await (await request.get(`${API}/public/movies`)).json();
  const slugs: string[] = (Array.isArray(listed) ? listed : listed.data).map(
    (m: { slug: string }) => m.slug,
  );
  for (const slug of [SEEDED, ...slugs.filter((s) => s !== SEEDED)]) {
    const shows = await showsFor(request, slug);
    if (Array.isArray(shows.shows) && wanted(shows)) return slug;
  }
  return null;
}

const bookable = (s: ShowRow) => s.availability === 'AVAILABLE' || s.availability === 'LIMITED';

async function openFilm(page: Page, slug: string) {
  await page.goto(`${CUSTOMER}/movies/${slug}`);
  await expect(page.getByTestId('showtime').first()).toBeVisible({ timeout: 20_000 });
}

test.describe('movie showtimes', () => {
  test('the date strip offers a week and switches days', async ({ page, request }) => {
    const slug = await findFilm(request, (r) => r.shows.some(bookable));
    expect(slug, 'a film with a bookable show is needed').toBeTruthy();
    await openFilm(page, slug!);

    const strip = page.getByRole('group', { name: 'Choose a date' });
    await expect(strip).toBeVisible();
    const days = strip.locator('button[aria-pressed]');
    await expect(days).toHaveCount(7);
    await expect(strip.locator('button[aria-pressed="true"]')).toHaveCount(1);

    // A day with nothing on says so, and cannot be chosen.
    const empty = strip.locator('button[aria-pressed][disabled]');
    for (let i = 0; i < (await empty.count()); i++) {
      await expect(empty.nth(i)).toHaveAttribute('aria-label', /No shows/);
    }

    const other = strip.locator('button[aria-pressed="false"]:not([disabled])').first();
    if (await other.count()) {
      const date = await other.getAttribute('data-date');
      await other.click();
      await expect(strip.locator(`button[data-date="${date}"]`)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(strip.locator('button[aria-pressed="true"]')).toHaveCount(1);
      await expect(page.getByTestId('showtime').first()).toBeVisible();
    }
  });

  test('a bookable showtime is a link to its seats', async ({ page, request }) => {
    const slug = await findFilm(request, (r) => r.shows.some(bookable));
    expect(slug, 'a film with a bookable show is needed').toBeTruthy();
    await openFilm(page, slug!);

    // The first link on the page is visible without touching anything — movie.spec relies on it.
    const link = page.locator('a[href^="/shows/"]').first();
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /^\/shows\/[^/]+$/);
    await expect(link).toHaveAttribute('data-availability', /^(AVAILABLE|LIMITED)$/);
    // Its name carries the availability, not just a time.
    await expect(link).toHaveAttribute('aria-label', /Available|Filling fast/);

    await link.click();
    await expect(page).toHaveURL(/\/shows\/.+/);
  });

  test('the time filter narrows the list to that part of the day', async ({ page, request }) => {
    const slug = await findFilm(request, (r) => r.shows.some(bookable));
    expect(slug, 'a film with a bookable show is needed').toBeTruthy();
    await openFilm(page, slug!);

    const pills = page.getByTestId('showtime');
    const before = await pills.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-time-of-day')),
    );
    const bucket = before[0]!;
    const expected = before.filter((b) => b === bucket).length;

    const timeGroup = page.getByRole('group', { name: 'Time', exact: true });
    await timeGroup.locator(`button[data-time-of-day="${bucket}"]`).click();
    await expect(timeGroup.locator(`button[data-time-of-day="${bucket}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await expect(pills).toHaveCount(expected);
    const after = await pills.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-time-of-day')),
    );
    expect(new Set(after)).toEqual(new Set([bucket]));

    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(pills).toHaveCount(before.length);
  });

  test('the format filter narrows the list to that format', async ({ page, request }) => {
    const slug = await findFilm(request, (r) => r.filters.formats.length > 1);
    test.skip(!slug, 'no published film is showing in more than one format');
    await openFilm(page, slug!);

    const formatGroup = page.getByRole('group', { name: 'Format', exact: true });
    await expect(formatGroup).toBeVisible();

    // A format actually on the chosen day, so the narrowed list is not empty.
    const pills = page.getByTestId('showtime');
    const formats = await pills.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-format') ?? ''),
    );
    const format = formats.find(Boolean);
    test.skip(!format, 'the opening day has no show with a format');
    const expected = formats.filter((f) => f === format).length;

    await formatGroup.locator(`button[data-format="${format}"]`).click();
    await expect(pills).toHaveCount(expected);
    const after = await pills.evaluateAll((els) => els.map((el) => el.getAttribute('data-format')));
    expect(new Set(after)).toEqual(new Set([format]));
  });

  test('sold-out and paused showtimes are not links', async ({ page, request }) => {
    /*
      Whether the seed has a sold-out show today is luck, so the response is edited in flight:
      the earliest shows are marked sold out and paused, and everything else is left real.
    */
    const slug = await findFilm(request, (r) => r.shows.filter((s) => s.localDate).length >= 2);
    expect(slug, 'a film with two dated shows is needed').toBeTruthy();

    let soldOut: ShowRow | undefined;
    let paused: ShowRow | undefined;
    await page.route(new RegExp(`/public/movies/${slug}/shows(\\?|$)`), async (route) => {
      const response = await route.fetch();
      const body: ShowsResponse = await response.json();
      const dated = body.shows.filter((s) => s.localDate);
      dated[0].availability = 'SOLD_OUT';
      dated[1].availability = 'SALES_PAUSED';
      soldOut = dated[0];
      paused = dated[1];
      await route.fulfill({ response, json: body });
    });

    await page.goto(`${CUSTOMER}/movies/${slug}`);
    await expect(page.getByRole('group', { name: 'Choose a date' })).toBeVisible({
      timeout: 20_000,
    });

    for (const [row, words] of [
      [soldOut!, 'Sold out'],
      [paused!, 'Sales paused'],
    ] as const) {
      const tile = page.locator(`button[data-date="${row.localDate}"]`);
      // The earliest days are on the first page of the strip; skip a row paged beyond it.
      if (!(await tile.count())) continue;
      if ((await tile.getAttribute('aria-pressed')) !== 'true') await tile.click();

      const pill = page.locator(`[data-testid="showtime"][data-session-id="${row.sessionId}"]`);
      await expect(pill).toBeVisible();
      await expect(pill).toHaveAttribute('data-availability', row.availability);
      expect(await pill.evaluate((el) => el.tagName)).not.toBe('A');
      await expect(pill).not.toHaveAttribute('href', /.*/);
      await expect(pill).toContainText(words);
      await expect(page.locator(`a[href="/shows/${row.sessionId}"]`)).toHaveCount(0);
    }

    // And every pill that is left bookable still is a link.
    const rendered = page.getByTestId('showtime');
    for (let i = 0; i < (await rendered.count()); i++) {
      const el = rendered.nth(i);
      const availability = await el.getAttribute('data-availability');
      const tag = await el.evaluate((node) => node.tagName);
      expect(tag === 'A').toBe(availability === 'AVAILABLE' || availability === 'LIMITED');
    }
  });
});
