import AxeBuilder from '@axe-core/playwright';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * Launch readiness and guided onboarding.
 *
 * Every level, message and fix path here comes from the REAL readiness API through the real
 * app. Nothing is stubbed and no rule is restated in a fixture — the point of the engine is
 * that there is one source of truth, and a test that hardcoded "no screens blocks" would
 * quietly keep passing after the policy changed.
 *
 * The fixtures therefore build genuinely incomplete cinemas and assert on what the server
 * concludes about them.
 */

const OWNER = 'owner@eticketsgo.test';
const CINEMA_TZ = 'Asia/Kolkata';

interface Fixture {
  cinemaId: string;
  screenId?: string;
  movieId?: string;
}

const describeViolations = (
  violations: {
    id: string;
    impact?: string | null;
    help: string;
    nodes: { target: unknown[] }[];
  }[],
) =>
  violations
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join('\n  ')}`,
    )
    .join('\n');

/** A cinema with nothing configured beyond its own record. Maximum blockers. */
async function createBareCinema(request: APIRequestContext, token: string): Promise<Fixture> {
  const auth = { Authorization: `Bearer ${token}` };
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs[0] : orgs.data?.[0])?.id as string;

  const cinema = await (
    await request.post(`${API}/cinemas`, {
      headers: auth,
      data: { organizationId, name: `Bare Cinema ${suffix}`, city: 'Hyderabad' },
    })
  ).json();
  return { cinemaId: cinema.id };
}

/** Add a screen with a published layout, so the layout blocker clears. */
async function addScreenWithLayout(request: APIRequestContext, token: string, f: Fixture) {
  const auth = { Authorization: `Bearer ${token}` };
  const screen = await (
    await request.post(`${API}/cinemas/${f.cinemaId}/screens`, {
      headers: auth,
      data: { name: 'Screen 1', screenType: '2D', capacity: 10 },
    })
  ).json();
  await request.post(`${API}/screens/${screen.id}/seatmap`, {
    headers: auth,
    data: {
      name: 'Main',
      sections: [
        {
          name: 'Stalls',
          categoryName: 'Normal',
          basePriceMinor: 20000,
          rowLabels: ['A'],
          seatsPerRow: 5,
        },
      ],
    },
  });
  f.screenId = screen.id;
  return screen.id;
}

const gotoReadiness = async (page: Page, f: Fixture) => {
  await page.goto(`${ORGANIZER}/organizer/cinemas/${f.cinemaId}/readiness`);
  await expect(page.getByRole('button', { name: 'Re-check' })).toBeVisible({ timeout: 20_000 });
  // The verdict card is a live region; waiting on it means the report has actually arrived.
  await expect(page.getByRole('status').first()).toBeVisible({ timeout: 20_000 });
};

test.describe('launch readiness', () => {
  let tokens: AuthTokens;
  let bare: Fixture;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, OWNER);
    bare = await createBareCinema(request, tokens.accessToken);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('1-3: an unconfigured cinema reports BLOCKED and says how many things to fix', async ({
    page,
  }) => {
    await gotoReadiness(page, bare);
    await expect(page.getByText('Blocking', { exact: true }).first()).toBeVisible();
    // The headline is actionable, not just a state word.
    await expect(
      page.getByText(/thing(s)? must be fixed before this cinema can open/),
    ).toBeVisible();
  });

  test('4-6: the specific blockers are named, each with somewhere to go', async ({ page }) => {
    await gotoReadiness(page, bare);

    // Straight from the engine — no screens, nothing scheduled, nothing discoverable.
    await expect(page.getByTestId('check-NO_ACTIVE_SCREEN')).toBeVisible();
    await expect(page.getByTestId('check-NO_FUTURE_SHOWS')).toBeVisible();

    const blocker = page.getByTestId('check-NO_ACTIVE_SCREEN');
    await expect(blocker).toHaveAttribute('data-level', 'BLOCKED');
    // A blocker with nothing to click is a support ticket.
    await expect(blocker.getByRole('link', { name: 'Fix this' })).toBeVisible();
  });

  test('7: the cinema section reports the authoritative timezone', async ({ page }) => {
    await gotoReadiness(page, bare);
    const tz = page.getByTestId('check-TIMEZONE_SET');
    await expect(tz).toHaveAttribute('data-level', 'READY');
    await expect(tz).toContainText(CINEMA_TZ);
  });

  test('8-9: warnings are shown and are distinguishable from blockers', async ({ page }) => {
    await gotoReadiness(page, bare);
    const warnings = page.locator('[data-level="WARNING"]');
    await expect(warnings.first()).toBeVisible();
    // Different words, not merely different colour.
    await expect(warnings.first().getByText('Needs review')).toBeVisible();
    await expect(page.getByTestId('check-NO_ACTIVE_SCREEN').getByText('Blocking')).toBeVisible();
  });

  test('10: a fix link navigates to the screen that fixes it', async ({ page }) => {
    await gotoReadiness(page, bare);
    await page.getByTestId('check-NO_FUTURE_SHOWS').getByRole('link', { name: 'Fix this' }).click();
    await expect(page).toHaveURL(new RegExp(`/organizer/cinemas/${bare.cinemaId}/schedule`));
  });

  test('11-13: fixing a blocker makes it disappear on re-check', async ({ page, request }) => {
    /*
      The whole promise of the page: an operator fixes something and immediately sees it
      clear. Asserted against the real engine rather than a stubbed second response, so a
      stale client cache would fail this.
    */
    const f = await createBareCinema(request, tokens.accessToken);
    await gotoReadiness(page, f);
    await expect(page.getByTestId('check-NO_ACTIVE_SCREEN')).toBeVisible();

    await addScreenWithLayout(request, tokens.accessToken, f);

    await page.getByRole('button', { name: 'Re-check' }).click();
    await expect(page.getByTestId('check-NO_ACTIVE_SCREEN')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('check-ACTIVE_SCREEN')).toHaveAttribute('data-level', 'READY');
  });

  test('14: another tenant cannot read this cinema’s readiness', async ({ request }) => {
    const other = await apiLogin(request, 'organizer2@eticketsgo.test');
    const res = await request.get(`${API}/cinemas/${bare.cinemaId}/pilot-readiness`, {
      headers: { Authorization: `Bearer ${other.accessToken}` },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('15: the verdict is announced, not only painted', async ({ page }) => {
    await gotoReadiness(page, bare);
    // role=status so an operator using a screen reader hears the result of a re-check.
    const status = page.getByRole('status').first();
    await expect(status).toContainText(/must be fixed|Ready to open|ready to open/);
  });

  test('a11y: the readiness page has no detectable violations', async ({ page }) => {
    await gotoReadiness(page, bare);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(describeViolations(results.violations)).toBe('');
  });
});

test.describe('guided onboarding', () => {
  let tokens: AuthTokens;
  let fixture: Fixture;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, OWNER);
    fixture = await createBareCinema(request, tokens.accessToken);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  const gotoOnboarding = async (page: Page) => {
    await page.goto(`${ORGANIZER}/organizer/cinemas/${fixture.cinemaId}/onboarding`);
    await expect(page.getByTestId('step-CINEMA')).toBeVisible({ timeout: 20_000 });
  };

  test('16-17: steps show readiness-derived state, not a stored checklist', async ({ page }) => {
    await gotoOnboarding(page);
    /*
      Three different states from one report, all derived rather than stored:
        SCREENS  BLOCKED  — nothing has been created
        CINEMA   WARNING  — the record exists but has no street address
        SHOWS    BLOCKED  — nothing scheduled
      CINEMA being WARNING rather than READY is the engine's call, not this test's: a bare
      cinema is usable but incomplete, and the step reflects that faithfully.
    */
    await expect(page.getByTestId('step-SCREENS')).toHaveAttribute('data-level', 'BLOCKED');
    await expect(page.getByTestId('step-CINEMA')).toHaveAttribute('data-level', 'WARNING');
    await expect(page.getByTestId('step-SHOWS')).toHaveAttribute('data-level', 'BLOCKED');
    await expect(page.getByText(/of \d+ steps complete/)).toBeVisible();
  });

  test('18: steps link to the EXISTING configuration screens', async ({ page }) => {
    await gotoOnboarding(page);
    await page.getByTestId('step-SHOWS').getByRole('link').click();
    // Not a wizard-owned copy of the scheduling workspace.
    await expect(page).toHaveURL(new RegExp(`/organizer/cinemas/${fixture.cinemaId}/schedule`));
  });

  test('19: steps with no self-service screen say so rather than linking nowhere', async ({
    page,
  }) => {
    await gotoOnboarding(page);
    const fees = page.getByTestId('step-FEES');
    await expect(fees.getByText('No self-service screen yet')).toBeVisible();
    // And explains who owns it, so the operator knows what to do next.
    await expect(page.getByText(/configured by ETicketsGo/)).toBeVisible();
  });

  test('20-21: progress reflects real configuration and survives a reload', async ({
    page,
    request,
  }) => {
    const f = await createBareCinema(request, tokens.accessToken);
    await page.goto(`${ORGANIZER}/organizer/cinemas/${f.cinemaId}/onboarding`);
    await expect(page.getByTestId('step-SCREENS')).toHaveAttribute('data-level', 'BLOCKED', {
      timeout: 20_000,
    });

    await addScreenWithLayout(request, tokens.accessToken, f);

    // Reload rather than an in-app refresh: derived progress must come from the server every
    // time, so a fresh page load shows the new truth with no client state involved.
    await page.reload();
    await expect(page.getByTestId('step-SCREENS')).toHaveAttribute('data-level', 'READY', {
      timeout: 20_000,
    });
  });

  test('22: another tenant cannot open this cinema’s onboarding data', async ({ request }) => {
    const other = await apiLogin(request, 'organizer2@eticketsgo.test');
    const res = await request.get(`${API}/cinemas/${fixture.cinemaId}/pilot-readiness`, {
      headers: { Authorization: `Bearer ${other.accessToken}` },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('a11y: the onboarding page has no detectable violations', async ({ page }) => {
    await gotoOnboarding(page);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(describeViolations(results.violations)).toBe('');
  });
});
