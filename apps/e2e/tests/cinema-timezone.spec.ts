import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * The cinema's stored timezone is authoritative in the browser too.
 *
 * ── WHAT THIS GUARDS ──────────────────────────────────────────────────────────────
 * Two failure modes, both of which have actually happened on this codebase:
 *
 *   1. The BROWSER's zone deciding a cinema's local day. A Hyderabad venue operated from
 *      London must show Hyderabad days; the operator's own clock is irrelevant.
 *   2. A hardcoded launch-market default standing in for the venue's zone. This is invisible
 *      while every cinema is in India, which is exactly why the non-India fixture below
 *      exists — against an Asia/Kolkata venue, "reads the cinema" and "hardcodes Kolkata"
 *      produce identical output and neither test would fail.
 *
 * The browser zones are chosen to sit either side of India and to differ in DST behaviour:
 * London (UTC+1 in summer), Boise (UTC-6, a day behind for most of India's day) and Sydney
 * (UTC+10, a day ahead). If any of them can change what the page reports, the guard is gone.
 */

const OWNER = 'owner@eticketsgo.test';

interface TzFixture {
  cinemaId: string;
  screenId: string;
  movieId: string;
  timezone: string;
  /** A local date at THIS cinema, comfortably in the future. */
  date: string;
  /** The wall-clock time seeded on that date. */
  time: string;
}

/** Local calendar date at a given zone, N days out. */
function localDateIn(timeZone: string, daysAhead: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(
    new Date(Date.now() + daysAhead * 86_400_000),
  );
}

/**
 * Build a cinema in a named zone with one show at a deliberately awkward hour.
 *
 * 00:30 is chosen because it is the hour that exposes zone bugs: it falls on the PREVIOUS
 * UTC day for India, and on a different day again for a viewer in Boise or Sydney.
 */
async function createCinemaIn(
  request: APIRequestContext,
  token: string,
  timezone: string,
  label: string,
): Promise<TzFixture> {
  const auth = { Authorization: `Bearer ${token}` };
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs[0] : orgs.data?.[0])?.id as string;

  const cinema = await (
    await request.post(`${API}/cinemas`, {
      headers: auth,
      data: { organizationId, name: `${label} ${suffix}`, city: label, timezone },
    })
  ).json();
  expect(cinema.timezone, 'the API must echo the stored zone').toBe(timezone);

  const screen = await (
    await request.post(`${API}/cinemas/${cinema.id}/screens`, {
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
          seatsPerRow: 4,
        },
      ],
    },
  });

  const movie = await (
    await request.post(`${API}/movies`, {
      headers: auth,
      data: {
        organizationId,
        title: `TZ Feature ${suffix}`,
        runtimeMinutes: 100,
        language: 'English',
        genres: ['Drama'],
      },
    })
  ).json();
  await request.post(`${API}/movies/${movie.id}/status`, {
    headers: auth,
    data: { status: 'PUBLISHED' },
  });

  const date = localDateIn(timezone, 45);
  const time = '00:30';
  const seeded = await (
    await request.post(`${API}/movies/${movie.id}/shows/bulk`, {
      headers: auth,
      // No timezone in the body: the CINEMA decides. If anything defaults to a literal, the
      // show lands at the wrong instant and every assertion below moves.
      data: { screenId: screen.id, dates: [date], times: [time], padMinutes: 0, dryRun: false },
    })
  ).json();
  if (!seeded?.created?.[0]) {
    throw new Error(`bulk schedule failed for ${timezone}: ${JSON.stringify(seeded)}`);
  }

  return { cinemaId: cinema.id, screenId: screen.id, movieId: movie.id, timezone, date, time };
}

const gotoSchedule = async (page: Page, f: TzFixture) => {
  await page.goto(`${ORGANIZER}/organizer/cinemas/${f.cinemaId}/schedule`);
  const dateInput = page.getByLabel('Date', { exact: true });
  await expect(dateInput).toBeVisible({ timeout: 20_000 });
  await dateInput.fill(f.date);
};

// ── An India cinema, viewed from three very different browser zones ────────────────

for (const browserZone of ['Europe/London', 'America/Boise', 'Australia/Sydney']) {
  test.describe(`Asia/Kolkata cinema operated from ${browserZone}`, () => {
    test.use({ timezoneId: browserZone });

    let tokens: AuthTokens;
    let fixture: TzFixture;

    test.beforeAll(async ({ request }) => {
      tokens = await apiLogin(request, OWNER);
      fixture = await createCinemaIn(request, tokens.accessToken, 'Asia/Kolkata', 'Hyderabad');
    });

    test.beforeEach(async ({ context }) => {
      await seedBrowserAuth(context, tokens);
    });

    test(`the show keeps its Hyderabad time and day in a ${browserZone} browser`, async ({
      page,
    }) => {
      await gotoSchedule(page, fixture);
      // 00:30 IST is 19:00 the previous day in UTC — and a different day again in Boise and
      // Sydney. The operator must see 00:30 on the cinema's date regardless.
      await expect(page.getByText('00:30')).toBeVisible({ timeout: 20_000 });
    });

    test(`the previous local day is empty in a ${browserZone} browser`, async ({ page }) => {
      const previous = new Date(new Date(`${fixture.date}T00:00:00Z`).getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      await page.goto(`${ORGANIZER}/organizer/cinemas/${fixture.cinemaId}/schedule`);
      await page.getByLabel('Date', { exact: true }).fill(previous);
      // A browser-zone implementation files the 00:30 show here for at least one of the
      // three zones above.
      await expect(page.getByText('00:30')).toHaveCount(0);
    });
  });
}

// ── A NON-INDIA cinema: the test an Asia/Kolkata fixture cannot perform ────────────

test.describe('a Sydney cinema is not treated as an India cinema', () => {
  // Browser deliberately in London, so neither the browser zone nor an India default
  // coincides with the venue's.
  test.use({ timezoneId: 'Europe/London' });

  let tokens: AuthTokens;
  let fixture: TzFixture;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, OWNER);
    fixture = await createCinemaIn(request, tokens.accessToken, 'Australia/Sydney', 'Sydney');
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('the schedule reports Sydney local time, not London and not India', async ({ page }) => {
    await gotoSchedule(page, fixture);
    await expect(page.getByText('00:30')).toBeVisible({ timeout: 20_000 });
    // The page states the zone it is reckoning in, so an operator can see it is not a guess.
    await expect(page.getByText('Australia/Sydney')).toBeVisible();
  });

  test('the stored instant is Sydney 00:30, which no other interpretation produces', async ({
    request,
  }) => {
    /*
      The decisive assertion, checked against the API rather than the DOM.

      00:30 on the fixture date in Sydney is a specific instant. If the platform had used
      Asia/Kolkata it would be 4h30m later; if it had used the server's UTC it would be
      00:30Z; if it had used the browser's London zone it would differ again. Only reading
      the cinema's stored zone produces this value.
    */
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const rows = await (
      await request.get(`${API}/cinemas/${fixture.cinemaId}/schedule?date=${fixture.date}`, {
        headers: auth,
      })
    ).json();
    expect(rows).toHaveLength(1);

    const asSydney = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(rows[0].startsAt));
    expect(asSydney).toBe('00:30');

    const asKolkata = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(rows[0].startsAt));
    // Emphatically NOT 00:30 — that would mean the launch default had been used.
    expect(asKolkata).not.toBe('00:30');
  });

  test('the API refuses a timezone the runtime cannot resolve', async ({ request }) => {
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
    const organizationId = (Array.isArray(orgs) ? orgs[0] : orgs.data?.[0])?.id as string;

    for (const bad of ['Middle/Earth', 'UTC+5:30']) {
      const res = await request.post(`${API}/cinemas`, {
        headers: auth,
        data: { organizationId, name: `Bad ${bad}`, city: 'Nowhere', timezone: bad },
      });
      // Stored, an unresolvable zone throws on every read instead of once at the edge.
      expect(res.status(), `${bad} must be rejected`).toBeGreaterThanOrEqual(400);
    }
  });
});
