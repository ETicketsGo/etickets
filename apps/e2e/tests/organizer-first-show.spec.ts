import { test, expect, type Page } from '@playwright/test';
import { API, ORGANIZER } from './helpers';

/**
 * The first show a brand-new organizer ever tries to schedule.
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────────────
 * Reported from QA: the "Schedule show" dialog on the movie page offered a Cinema dropdown
 * containing nothing but its placeholder, left Screen disabled at "Pick a cinema first",
 * and answered a submit with "Pick a screen." — an instruction that cannot be followed,
 * about a list that is empty for a reason the dialog never mentions.
 *
 * Every API call behind it worked. The walk from signup to a paid ticket passes 26/26
 * against the deployed environment. What was missing was the product saying which of the
 * three setup steps had not been done yet, and where to do it.
 *
 * So these tests assert the GUIDANCE, not the endpoints: the state a new organizer is
 * actually in, and whether the screen in front of them offers a way out of it.
 */
const PASSWORD = 'Password123!';

async function freshOrganizer(page: Page) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `firstshow_${stamp}@e2e.test`;
  const reg = await page.request.post(`${API}/auth/register`, {
    data: { email, password: PASSWORD, fullName: 'First Show' },
  });
  const tokens = (await reg.json()) as { accessToken: string; refreshToken: string };

  // Becoming an organizer is what grants the role; the session must be refreshed to carry it.
  await page.request.post(`${API}/organizations`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    data: { name: `First Show Theatres ${stamp}`, contactEmail: 'ops@example.test' },
  });
  const refreshed = await (
    await page.request.post(`${API}/auth/refresh`, { data: { refreshToken: tokens.refreshToken } })
  ).json();

  await page.addInitScript((t) => {
    localStorage.setItem('etg_access', t.accessToken);
    localStorage.setItem('etg_refresh', t.refreshToken);
  }, refreshed);

  const orgs = await (
    await page.request.get(`${API}/organizations`, {
      headers: { Authorization: `Bearer ${refreshed.accessToken}` },
    })
  ).json();
  return { token: refreshed.accessToken as string, organizationId: orgs[0].id as string, stamp };
}

async function createMovie(page: Page, token: string, organizationId: string, stamp: string) {
  const movie = await (
    await page.request.post(`${API}/movies`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        organizationId,
        title: `First Show Feature ${stamp}`,
        runtimeMinutes: 120,
        language: 'Hindi',
        genres: ['Drama'],
      },
    })
  ).json();
  return movie.id as string;
}

const openScheduleDialog = async (page: Page, movieId: string) => {
  await page.goto(`${ORGANIZER}/organizer/movies/${movieId}`);
  await page.getByRole('button', { name: 'Schedule show' }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 20_000 });
};

test.describe('the first show', () => {
  test('1-3: with no cinema, the dialog says so and offers the way out', async ({ page }) => {
    const { token, organizationId, stamp } = await freshOrganizer(page);
    const movieId = await createMovie(page, token, organizationId, stamp);

    await openScheduleDialog(page, movieId);

    // The state the screenshot showed. Now named rather than left to be inferred from an
    // empty dropdown.
    await expect(page.getByText('You have no cinemas yet.')).toBeVisible();
    await expect(page.getByRole('link', { name: /Create a cinema/ })).toBeVisible();

    // And the dropdown itself stops pretending there is something to choose.
    await expect(page.getByLabel('Cinema')).toContainText('No cinemas yet');
  });

  test('4: Schedule is not offered when it could only fail', async ({ page }) => {
    const { token, organizationId, stamp } = await freshOrganizer(page);
    const movieId = await createMovie(page, token, organizationId, stamp);
    await openScheduleDialog(page, movieId);

    // Previously enabled, and answering with "Pick a screen." — an instruction that could
    // not be followed from this dialog.
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Schedule', exact: true }),
    ).toBeDisabled();
  });

  test('5: the link lands on the page that actually creates a cinema', async ({ page }) => {
    const { token, organizationId, stamp } = await freshOrganizer(page);
    const movieId = await createMovie(page, token, organizationId, stamp);
    await openScheduleDialog(page, movieId);

    await page.getByRole('link', { name: /Create a cinema/ }).click();
    await expect(page).toHaveURL(/\/organizer\/cinemas\/new/, { timeout: 20_000 });
  });

  test('6-8: with a cinema but no screen, it says THAT instead', async ({ page }) => {
    const { token, organizationId, stamp } = await freshOrganizer(page);
    const movieId = await createMovie(page, token, organizationId, stamp);

    // A cinema, deliberately with no screens — the second dead end in the chain.
    const cinema = await (
      await page.request.post(`${API}/cinemas`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          organizationId,
          name: `Empty Cinema ${stamp}`,
          city: 'Bengaluru',
          timezone: 'Asia/Kolkata',
        },
      })
    ).json();

    await openScheduleDialog(page, movieId);
    await page.getByLabel('Cinema').selectOption(cinema.id);

    await expect(page.getByText('This cinema has no screens yet.')).toBeVisible();
    await expect(page.getByRole('link', { name: /Add a screen/ })).toBeVisible();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Schedule', exact: true }),
    ).toBeDisabled();
  });

  test('9: once a screen with a layout exists, scheduling works', async ({ page }) => {
    const { token, organizationId, stamp } = await freshOrganizer(page);
    const movieId = await createMovie(page, token, organizationId, stamp);
    const auth = { Authorization: `Bearer ${token}` };

    const cinema = await (
      await page.request.post(`${API}/cinemas`, {
        headers: auth,
        data: {
          organizationId,
          name: `Ready Cinema ${stamp}`,
          city: 'Bengaluru',
          timezone: 'Asia/Kolkata',
        },
      })
    ).json();
    const screen = await (
      await page.request.post(`${API}/cinemas/${cinema.id}/screens`, {
        headers: auth,
        data: { name: 'Screen 1', screenType: '2D', capacity: 20 },
      })
    ).json();
    await page.request.post(`${API}/screens/${screen.id}/seatmap`, {
      headers: auth,
      data: {
        name: 'Main',
        sections: [
          {
            name: 'Stalls',
            categoryName: 'STANDARD',
            basePriceMinor: 20000,
            rowLabels: ['A'],
            seatsPerRow: 5,
          },
        ],
      },
    });

    await openScheduleDialog(page, movieId);
    await page.getByLabel('Cinema').selectOption(cinema.id);
    await page.getByLabel('Screen').selectOption(screen.id);

    // No warnings left, and the action is available.
    await expect(page.getByText('You have no cinemas yet.')).toBeHidden();
    await expect(page.getByText('This cinema has no screens yet.')).toBeHidden();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Schedule', exact: true }),
    ).toBeEnabled();
  });

  test('10: the schedule page points at where a screen is added', async ({ page }) => {
    const { token, organizationId, stamp } = await freshOrganizer(page);
    const cinema = await (
      await page.request.post(`${API}/cinemas`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          organizationId,
          name: `Sched Cinema ${stamp}`,
          city: 'Bengaluru',
          timezone: 'Asia/Kolkata',
        },
      })
    ).json();

    await page.goto(`${ORGANIZER}/organizer/cinemas/${cinema.id}/schedule`);
    await expect(page.getByText('No screens yet')).toBeVisible({ timeout: 20_000 });
    // Previously it said "Add a screen to this cinema" and offered nowhere to do it.
    await expect(page.getByRole('link', { name: 'Add a screen' })).toBeVisible();
  });
});
