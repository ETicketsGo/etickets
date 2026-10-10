import { test, expect, type Browser } from '@playwright/test';
import { ADMIN, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * Both calendars mark the same "today" for the same reader at the same instant.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * The owner: "Organizer highlights October 9 while Admin highlights October 10." The organizer
 * calendar took today from the browser's zone; the admin calendar fell through to UTC. Each was
 * consistent with itself, so only putting the two side by side, at an hour when the reader's date
 * and the UTC date differ, shows it.
 *
 * ── THE POLICY UNDER TEST ──────────────────────────────────────────────────────────
 * "Today" is the viewer's local date in the zone their browser reports (`viewer-today.ts` in
 * shared-types). So each app is driven in a browser pinned to one zone, with its clock pinned to
 * one instant, and the cell it marks `aria-current="date"` must be the date at that instant in
 * that zone - worked out here, in Node, independently of the apps. Both apps meeting the same
 * expectation is the agreement the owner asked for.
 *
 * ── NO HARDCODED DATES ─────────────────────────────────────────────────────────────
 * The reference instant is the most recent UTC midnight, taken once when the file loads, and the
 * instants under test sit just after it and just after Kolkata's midnight. A pinned date years
 * away would put the browser's clock far from the sign-in token's, and that is a different test.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const REFERENCE = Math.floor(Date.now() / (24 * HOUR)) * (24 * HOUR);

/** Instants where the zones under test disagree about the date. */
const INSTANTS: Record<string, number> = {
  // 00:30 UTC: still the previous evening in Denver, morning in Kolkata.
  'just after UTC midnight': REFERENCE + 30 * MINUTE,
  // 00:30 in Kolkata: still the previous day in UTC and in Denver.
  'just after Kolkata midnight': REFERENCE - 5 * HOUR,
};
const ZONES = ['UTC', 'America/Denver', 'Asia/Kolkata'];

/** The calendar date at an instant in a zone, by Intl in Node - not by the code under test. */
function dateIn(instant: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

const APPS = [
  { name: 'organizer', url: `${ORGANIZER}/organizer/calendar?view=month`, login: 'owner' },
  { name: 'admin', url: `${ADMIN}/admin/calendar?view=month`, login: 'admin' },
] as const;

const tokens: Record<string, AuthTokens> = {};

test.beforeAll(async ({ request }) => {
  // One sign-in per account for the whole file: the auth throttle counts requests, not people.
  tokens.owner = await apiLogin(request, 'owner@eticketsgo.test');
  tokens.admin = await apiLogin(request, 'admin@eticketsgo.test');
});

async function markedToday(browser: Browser, app: (typeof APPS)[number], zone: string, at: number) {
  const context = await browser.newContext({
    timezoneId: zone,
    viewport: { width: 1280, height: 900 },
  });
  await seedBrowserAuth(context, tokens[app.login]);
  const page = await context.newPage();
  try {
    await page.clock.setFixedTime(new Date(at));
    await page.goto(app.url);
    const cell = page.locator('[aria-current="date"]');
    await expect(cell).toHaveCount(1);
    const zoneLine = await page.getByTestId('calendar-today-zone').innerText();
    return { day: await cell.getAttribute('data-day'), zoneLine };
  } finally {
    await context.close();
  }
}

for (const app of APPS) {
  test.describe(`${app.name} calendar: today is the viewer's date`, () => {
    for (const [moment, at] of Object.entries(INSTANTS)) {
      for (const zone of ZONES) {
        test(`${zone}, ${moment}`, async ({ browser }) => {
          const seen = await markedToday(browser, app, zone, at);
          expect({ zone, day: seen.day }).toEqual({ zone, day: dateIn(at, zone) });
          // And the page says which zone "today" was taken in.
          expect(seen.zoneLine).toContain(zone);
        });
      }
    }
  });
}
