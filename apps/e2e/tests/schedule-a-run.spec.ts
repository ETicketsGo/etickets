import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, ORGANIZER, apiLogin } from './helpers';

/**
 * Booking a film in for a week, and moving a show that is already on sale.
 *
 * ── THE TWO COMPLAINTS THIS ANSWERS ────────────────────────────────────────────────
 * "Show times are unable to edit after creation" and "what if a movie is playing for one
 * week — it is hard to create 7×4 shows". Both were UI gaps, not missing capability:
 * `POST /shows/:id/reschedule` and `POST /movies/:id/shows/bulk` had existed the whole time
 * with nothing in the console calling either.
 *
 * The run dialog always dry-runs first. Twenty-eight showtimes is twenty-eight chances to
 * collide with something already on the screen, and a batch that half-succeeds leaves the
 * operator working out which half — so what WILL happen is shown before anything is written.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

interface Fixture {
  movieId: string;
  screenName: string;
  cinemaName: string;
}

/** A film and a screen of their own, so repeated runs never fight over a slot. */
async function fixture(request: APIRequestContext): Promise<Fixture> {
  const { accessToken } = await apiLogin(request, ORGANIZER_EMAIL);
  const auth = { Authorization: `Bearer ${accessToken}` };
  const stamp = Date.now();

  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const cinemas = await (
    await request.get(`${API}/cinemas?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const cinema = (Array.isArray(cinemas) ? cinemas : cinemas.data)[0];

  const screenName = `Run E2E ${stamp}`;
  const screen = await (
    await request.post(`${API}/cinemas/${cinema.id}/screens`, {
      headers: auth,
      data: { name: screenName, screenType: '2D', capacity: 60 },
    })
  ).json();
  await request.post(`${API}/screens/${screen.id}/seatmap`, {
    headers: auth,
    data: {
      name: 'Stalls',
      sections: [
        {
          name: 'Stalls',
          categoryName: 'Standard',
          basePriceMinor: 15_000,
          rowLabels: ['A', 'B'],
          seatsPerRow: 6,
        },
      ],
    },
  });

  const movie = await (
    await request.post(`${API}/movies`, {
      headers: auth,
      data: {
        organizationId,
        title: `Run Film ${stamp}`,
        runtimeMinutes: 100,
        language: 'English',
        certificate: 'U',
        genres: ['Drama'],
      },
    })
  ).json();
  expect(movie.id, `movie creation failed: ${JSON.stringify(movie)}`).toBeTruthy();
  await request.patch(`${API}/movies/${movie.id}/status`, {
    headers: auth,
    data: { status: 'PUBLISHED' },
  });

  return { movieId: movie.id, screenName, cinemaName: cinema.name };
}

/** A local calendar date N days out, as the date input wants it. */
const dayOffset = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
};

test.describe('scheduling a run', () => {
  let fx: Fixture;
  const FIRST = dayOffset(400);
  const LAST = dayOffset(406);

  test.beforeAll(async ({ request }) => {
    fx = await fixture(request);
  });

  test.beforeEach(async ({ context, request }) => {
    // Tokens over the API rather than the login form: this suite opens several pages and
    // signing in on each trips the auth throttle.
    const tokens = await apiLogin(request, ORGANIZER_EMAIL);
    await context.addInitScript((t) => {
      localStorage.setItem('etg_access', t.accessToken);
      localStorage.setItem('etg_refresh', t.refreshToken);
    }, tokens);
  });

  /** Fill the run form. Times are whatever chips are already on, plus the ones named. */
  async function openRun(page: Page) {
    await page.goto(`${ORGANIZER}/organizer/movies/${fx.movieId}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Schedule a run' }).click();
    const dialog = page.getByRole('dialog', { name: /Schedule a run/ });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Screen').selectOption({ label: fx.screenName });
    await dialog.getByLabel('First day').fill(FIRST);
    await dialog.getByLabel('Last day').fill(LAST);
    return dialog;
  }

  test('1: a week of daily showtimes is one action, previewed before it is written', async ({
    page,
  }) => {
    const dialog = await openRun(page);

    // Seven days x three default times.
    await expect(dialog.getByText('7 days in this range')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Preview 21 shows/ })).toBeVisible();

    await dialog.getByRole('button', { name: /^Preview/ }).click();

    /*
      Nothing is written by a preview, and the button changes to say exactly how many will
      be — because a batch with conflicts creates FEWER than were planned, and a button
      reading "Schedule" over such a list is a promise it cannot keep.
    */
    await expect(dialog.getByText('21 will be created')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole('button', { name: 'Create 21 shows' })).toBeEnabled();

    await dialog.getByRole('button', { name: 'Create 21 shows' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // And they are really there.
    await expect(page.getByRole('button', { name: /Move the/ }).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test('2: running it again reports every clash, in the venue timezone', async ({ page }) => {
    const dialog = await openRun(page);
    await dialog.getByRole('button', { name: /^Preview/ }).click();

    await expect(dialog.getByText('0 will be created, 21 cannot')).toBeVisible({
      timeout: 30_000,
    });
    // Nothing to create, so the commit is refused rather than offered.
    await expect(dialog.getByRole('button', { name: 'Create 0 shows' })).toBeDisabled();

    /*
      A negative gap means the windows genuinely overlap. Rendering it literally produced
      "only -116 min between them", which means nothing to somebody fixing a schedule.
    */
    await expect(
      dialog.getByText(/Overlaps a show already on this screen by \d+ min/).first(),
    ).toBeVisible();

    /*
      And the times are the venue's, not the reader's.

      A browser in London formatting an Indian 14:30 show renders 09:00, and a conflict list
      whose times are not the times the operator typed cannot be acted on. The zone is named
      so there is no guessing.
    */
    await expect(dialog.getByText(/times shown in \w+\/\w+/)).toBeVisible();
  });

  test('3: a showtime can be moved after it exists', async ({ page }) => {
    /*
      The other complaint. `reschedule` has always existed and nothing called it, so a
      showtime typed wrongly could only be cancelled and recreated — which strands anybody
      who has already bought a seat.
    */
    await page.goto(`${ORGANIZER}/organizer/movies/${fx.movieId}`, { waitUntil: 'networkidle' });
    const move = page.getByRole('button', { name: /Move the/ }).first();
    await expect(move).toBeVisible({ timeout: 30_000 });
    await move.click();

    const dialog = page.getByRole('dialog', { name: /Move the/ });
    await expect(dialog).toBeVisible();
    // Prefilled with where it is now, so "half an hour later" is an edit not a re-entry.
    await expect(dialog.locator('#move-to')).not.toHaveValue('');
    // Only the start is editable — the end follows the film's runtime.
    await expect(dialog.getByText(/The end time moves with it/)).toBeVisible();

    await dialog.locator('#move-to').fill(dayOffset(420));
    await dialog.locator('#move-to-time').selectOption('16:00');
    await dialog.getByRole('button', { name: 'Move it' }).click();

    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText('Showtime moved.')).toBeVisible({ timeout: 30_000 });
  });
});
