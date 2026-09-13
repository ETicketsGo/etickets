import { test, expect, type Page, type Route } from '@playwright/test';
import { CUSTOMER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * Film ratings: the poster strip, the hero chip, the ratings section and the rate panel.
 *
 * ── WHY THE API IS INTERCEPTED ─────────────────────────────────────────────────────
 * Rating a film needs a confirmed booking for a show that has STARTED, and a test cannot make
 * time pass. So the rating fields, the review summary and the viewer's eligibility are written
 * into the responses in flight, while everything else — the film, its showtimes, sign-in — stays
 * real. The assertions are about what the storefront does with each answer the API can give.
 */

const SLUG = 'skyfront-protocol';
const ELIGIBLE_EVENT = 'evt_rating_e2e';
const RATING = { average: 4.3, count: 1234 };

const SUMMARY = {
  average: 4.3,
  count: 1234,
  distribution: { '5': 700, '4': 300, '3': 134, '2': 60, '1': 40 },
  items: [
    {
      id: 'rev_1',
      rating: 5,
      comment: 'The zero-gravity chase alone is worth the ticket.',
      author: 'Priya S.',
      createdAt: '2026-09-10T18:30:00.000Z',
    },
  ],
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Adds a rating to every film the movie endpoints return, list and detail alike. */
async function rateEveryFilm(page: Page) {
  await page.route('**/public/movies**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (Array.isArray(body)) {
      body.forEach((m: Record<string, unknown>) => (m.rating = RATING));
    } else if (Array.isArray(body?.data)) {
      body.data.forEach((m: Record<string, unknown>) => (m.rating = RATING));
    } else if (body?.movie) {
      body.movie.rating = RATING;
    } else if (body && typeof body === 'object') {
      body.rating = RATING;
    }
    await route.fulfill({ response, json: body });
  });
}

async function withSummary(page: Page, summary: unknown = SUMMARY) {
  await page.route('**/public/reviews/movies/**', (route) => json(route, summary));
}

async function withEligibility(
  page: Page,
  mine: { review: unknown; eligibleEventId: string | null; reason: string | null },
) {
  await page.route('**/reviews/movies/**/mine', (route) => json(route, mine));
}

async function openFilm(page: Page) {
  await page.goto(`${CUSTOMER}/movies/${SLUG}`);
  await expect(page.getByRole('heading', { name: 'Ratings & reviews' })).toBeVisible({
    timeout: 20_000,
  });
}

test.describe('film ratings', () => {
  // The storefront refetches its lists; a rewrite still in flight when a test ends must not fail the next one.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('a rated film shows its rating on the poster card', async ({ page }) => {
    await rateEveryFilm(page);
    await page.goto(`${CUSTOMER}/movies`);

    const card = page.locator('a[href^="/movies/"]').first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('4.3/5');
    await expect(card).toContainText('1.2K votes');
    // The accessible wording carries the exact count, not the abbreviation.
    await expect(card).toContainText('Rated 4.3 out of 5 by 1,234 people');
    // Still one link: the strip is text inside it, not a control of its own.
    await expect(card.locator('a, button')).toHaveCount(0);
  });

  test('a poster that does not load leaves the placeholder, not a broken image', async ({
    page,
  }) => {
    // The seeded poster host was unreachable locally: its alt text spilled over the certificate.
    await page.route('**/public/movies**', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const rows = Array.isArray(body) ? body : (body?.data ?? []);
      rows.forEach(
        (m: Record<string, unknown>) => (m.posterUrl = `${CUSTOMER}/no-such-poster.jpg`),
      );
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${CUSTOMER}/movies`);

    const card = page.locator('a[href^="/movies/"]').first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('img')).toHaveCount(0);
  });

  test('the film page shows the hero chip and the ratings section', async ({ page }) => {
    await rateEveryFilm(page);
    await withSummary(page);
    await openFilm(page);

    const chip = page.locator('a[href="#ratings"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('4.3/5');
    await expect(chip).toContainText('1.2K votes');

    const section = page.locator('section#ratings');
    await expect(section).toContainText('4.3');
    await expect(section).toContainText('1,234 ratings');

    const breakdown = section.getByRole('list', { name: 'Rating breakdown' });
    await expect(breakdown.getByRole('listitem')).toHaveCount(5);
    // Each bar has a text equivalent, not just a width.
    await expect(breakdown).toContainText('5 stars: 700 ratings (57%)');

    await expect(section).toContainText('Recent reviews');
    await expect(section).toContainText('Priya S.');
    await expect(section).toContainText('The zero-gravity chase alone is worth the ticket.');

    // The showtimes above still work.
    await expect(page.locator('a[href^="/shows/"]').first()).toBeVisible();
  });

  test('a signed-out visitor is asked to sign in and come back', async ({ page }) => {
    await withSummary(page);
    await openFilm(page);

    const signIn = page.getByRole('link', { name: 'Sign in to rate' });
    await expect(signIn).toBeVisible();
    const href = await signIn.getAttribute('href');
    expect(decodeURIComponent(href ?? '')).toContain(`/login?next=/movies/${SLUG}#ratings`);
    await expect(page.getByRole('group', { name: 'Your rating' })).toHaveCount(0);
  });

  test.describe('signed in', () => {
    let tokens: Awaited<ReturnType<typeof apiLogin>>;
    test.beforeAll(async ({ request }) => {
      tokens = await apiLogin(request, 'customer1@eticketsgo.test');
    });
    test.beforeEach(async ({ context }) => {
      await seedBrowserAuth(context, tokens);
    });

    test('an eligible viewer picks stars and submits', async ({ page }) => {
      await withSummary(page, { average: 0, count: 0, distribution: {}, items: [] });
      await withEligibility(page, { review: null, eligibleEventId: ELIGIBLE_EVENT, reason: null });

      let posted: { eventId?: string; rating?: number; comment?: string } | null = null;
      await page.route('**/reviews', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        posted = route.request().postDataJSON();
        await json(
          route,
          { id: 'rev_new', rating: posted?.rating, comment: posted?.comment ?? null },
          201,
        );
      });

      await openFilm(page);
      await expect(page.getByText('Be the first to rate this film')).toBeVisible();

      const stars = page.getByRole('group', { name: 'Your rating' });
      await expect(stars).toBeVisible();
      const submit = page.getByRole('button', { name: 'Submit rating' });
      await expect(submit).toBeDisabled();

      await stars.getByRole('button', { name: '4 stars' }).click();
      await expect(page.getByText('Very good')).toBeVisible();
      await page.getByLabel('Your review (optional)').fill('Tense, clever, and gorgeous in IMAX.');
      await expect(submit).toBeEnabled();

      const request = page.waitForRequest(
        (r) => r.method() === 'POST' && /\/reviews$/.test(new URL(r.url()).pathname),
      );
      await submit.click();
      await request;

      expect(posted).toMatchObject({
        eventId: ELIGIBLE_EVENT,
        rating: 4,
        comment: 'Tense, clever, and gorgeous in IMAX.',
      });
      await expect(page.getByText('Thanks — your rating is in.')).toBeVisible();
    });

    test('a viewer whose show has not started is told when they can rate', async ({ page }) => {
      await withSummary(page);
      await withEligibility(page, { review: null, eligibleEventId: null, reason: 'NOT_STARTED' });
      await openFilm(page);

      await expect(
        page.getByText('You can rate this film once your show has started.'),
      ).toBeVisible();
      await expect(page.getByRole('group', { name: 'Your rating' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Submit rating' })).toHaveCount(0);
    });
  });
});
