import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * Long names never make the console header overlap itself - organizer AND admin.
 *
 * Reported twice on QA: "Lakshmi Cinemas 1791605120706" covered the Light option at
 * 1024-1440px, because the masthead was centred over the header with no idea the controls
 * were there. The organization name is not the only long string up there: the signed-in
 * person's name and address are too, and admin has those without a masthead.
 *
 * So both consoles are loaded with a 40+ character organization name AND a 40+ character
 * person, served by rewriting the API answers in the browser (renaming seeded rows would
 * change a database other people's tests read), and EVERY pair of things in the header -
 * buttons, links, radios, the masthead, the account block - is checked for overlapping
 * rectangles. Geometry, not a screenshot: two boxes overlapping is a fact.
 */

const LONG_ORG = 'Lakshmi Venkateswara Cinemas Pvt Ltd 001'; // 40 characters
const LONG_PERSON = 'Venkata Satya Narayana Murthy Chowdary Garu'; // 43 characters
const LONG_EMAIL = 'venkata.satya.narayana.murthy@eticketsgo.test';

const WIDTHS = [390, 768, 1024, 1280, 1440];

async function longNames(page: Page) {
  await page.route(
    (url) => url.pathname.endsWith('/api/organizations'),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const orgs = (await res.json()) as { name: string }[];
      await route.fulfill({ response: res, json: orgs.map((o) => ({ ...o, name: LONG_ORG })) });
    },
  );
  await page.route(
    (url) => url.pathname.endsWith('/api/auth/me'),
    async (route) => {
      const res = await route.fetch();
      const me = await res.json();
      await route.fulfill({
        response: res,
        json: { ...me, fullName: LONG_PERSON, email: LONG_EMAIL },
      });
    },
  );
}

/** Every pair of visible things in the header whose rectangles overlap, by name. */
async function headerCollisions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) return ['no header rendered'];
    const nodes = Array.from(
      header.querySelectorAll<HTMLElement>(
        'button, a, input, select, [role="radio"], [data-testid="workspace-name"], [data-testid="account-name"]',
      ),
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
    const name = (el: HTMLElement) =>
      (el.getAttribute('aria-label') || el.dataset.testid || el.textContent || el.tagName)
        .trim()
        .slice(0, 40);
    const hits: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (a.contains(b) || b.contains(a)) continue;
        const r = a.getBoundingClientRect();
        const s = b.getBoundingClientRect();
        const apart =
          r.right <= s.left || r.left >= s.right || r.bottom <= s.top || r.top >= s.bottom;
        if (!apart) hits.push(`${name(a)} <> ${name(b)}`);
      }
    }
    // And nothing in the header pushes the page sideways.
    const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (over > 2) hits.push(`page scrolls sideways by ${over}px`);
    return hits;
  });
}

for (const app of [
  { name: 'organizer', base: ORGANIZER, email: 'owner@eticketsgo.test', home: '/organizer' },
  { name: 'admin', base: ADMIN, email: 'admin@eticketsgo.test', home: '/admin' },
]) {
  test.describe(`${app.name} header with long names`, () => {
    let tokens: Awaited<ReturnType<typeof apiLogin>>;
    test.beforeAll(async ({ request }) => {
      tokens = await apiLogin(request, app.email);
    });

    for (const w of WIDTHS) {
      test(`${w}px: nothing in the header overlaps`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: w, height: 800 } });
        await seedBrowserAuth(context, tokens);
        const page = await context.newPage();
        await longNames(page);
        try {
          await page.goto(`${app.base}${app.home}`);
          await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({
            timeout: 30_000,
          });
          await page.waitForLoadState('networkidle').catch(() => undefined);
          if (app.name === 'organizer') {
            // The long name is really what is on screen, whole, for assistive technology.
            await expect(page.locator('header [data-testid="workspace-name"]:visible')).toHaveText(
              LONG_ORG,
            );
          }
          if (w >= 1024) {
            await expect(page.locator('header [data-testid="account-name"]')).toContainText(
              LONG_PERSON,
            );
          }
          expect(await headerCollisions(page)).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  });
}
