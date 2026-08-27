import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, ADMIN, CUSTOMER, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * Every page in all three web apps, scanned against WCAG 2.1 A and AA.
 *
 * ── WHY THIS REPLACED THE SPOT CHECKS ──────────────────────────────────────────────
 * There were six axe assertions in this suite and all six were on organizer-web. The
 * storefront — the part of the product that is a place of public accommodation, and the part
 * a claim would be about — had none. The first run of this file found two rules failing on
 * nineteen storefront routes at once, both of which had been "fixed" twice before on
 * whichever single screen somebody happened to scan.
 *
 * ── WHAT A SCAN CAN AND CANNOT ESTABLISH ───────────────────────────────────────────
 * Automated rules catch perhaps a third of WCAG, and none of the judgement: whether alt text
 * is ACCURATE, whether a heading order is MEANINGFUL, whether a flow is operable by keyboard
 * end to end, whether an error message actually tells somebody what to do. A clean run here
 * is a floor, not a conformance claim, and `docs/accessibility/README.md` says so in the
 * words that belong in a VPAT.
 *
 * Kept honest by failing rather than reporting. A scan whose output nobody has to act on
 * decays into a dashboard, and the whole reason the storefront regressed unnoticed is that
 * nothing was watching it.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Public storefront. The commercial surface, and the one with the widest audience. */
const CUSTOMER_PUBLIC = [
  '/',
  '/about',
  '/blog',
  '/changelog',
  '/contact',
  '/customers',
  '/discover',
  '/docs',
  '/docs/api',
  '/events',
  '/explore',
  '/faq',
  '/features',
  '/help',
  '/help/bug',
  '/help/contact',
  '/help/feature',
  '/login',
  '/movies',
  '/organizer-agreement',
  '/organizers',
  '/pricing',
  '/privacy',
  '/refunds',
  '/register',
  '/solutions',
  '/terms',
  '/checkout/cancel',
  '/checkout/success',
];

/** Signed in as a customer: the account area, where somebody manages what they bought. */
const CUSTOMER_PRIVATE = [
  '/account',
  '/account/become-organizer',
  '/account/bookings',
  '/account/following',
  '/account/notifications',
  '/account/profile',
  '/account/saved',
  '/account/tickets',
];

const ORGANIZER_ROUTES = [
  '/organizer',
  '/organizer/events',
  '/organizer/events/new',
  '/organizer/movies',
  '/organizer/cinemas',
  '/organizer/promotions',
  '/organizer/payouts',
  '/organizer/receipts',
  '/organizer/refunds',
  '/organizer/notifications',
  '/organizer/team',
  '/organizer/premium',
  '/organizer/help',
  '/organizer/settings',
];

const ADMIN_ROUTES = [
  '/admin',
  '/admin/organizers',
  '/admin/events',
  '/admin/movies',
  '/admin/users',
  '/admin/bookings',
  '/admin/refunds',
  '/admin/payouts',
  '/admin/payments',
  '/admin/reports',
  '/admin/staff',
  '/admin/audit',
  '/admin/settings',
  '/admin/support',
  '/admin/ops',
];

/**
 * Scan one page and fail with something a person can act on.
 *
 * The default axe failure is a wall of JSON. What somebody fixing this needs is the rule, the
 * element, and the measured reason — so that is what the message carries, and nothing else.
 */
async function scan(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();

  const report = results.violations.flatMap((v) =>
    v.nodes.map(
      (n) =>
        `  [${v.impact}] ${v.id} — ${v.help}\n` +
        `      element: ${n.html.slice(0, 160)}\n` +
        `      reason:  ${(n.any[0]?.message ?? n.all[0]?.message ?? '').slice(0, 200)}`,
    ),
  );

  expect(
    report,
    `${report.length} WCAG 2.1 AA violation(s) on ${url}\n${report.join('\n')}\n` +
      `\nSee docs/accessibility/README.md. If a rule genuinely does not apply here, ` +
      `say why in that file — do not delete the route from the sweep.`,
  ).toEqual([]);
}

test.describe('accessibility sweep: the public storefront', () => {
  test.describe.configure({ mode: 'serial' });

  for (const route of CUSTOMER_PUBLIC) {
    test(`customer ${route}`, async ({ page }) => {
      await scan(page, `${CUSTOMER}${route}`);
    });
  }
});

test.describe('accessibility sweep: a signed-in customer', () => {
  test.describe.configure({ mode: 'serial' });

  /*
    One token pair for the whole group. The auth throttle counts requests, not logins, and a
    sweep is the worst possible shape for it — dozens of pages, each of which would otherwise
    sign in again.
  */
  let tokens: Awaited<ReturnType<typeof apiLogin>>;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, 'customer1@eticketsgo.test');
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  for (const route of CUSTOMER_PRIVATE) {
    test(`customer ${route}`, async ({ page }) => {
      await scan(page, `${CUSTOMER}${route}`);
    });
  }

  test('customer /events/[slug] — a real event page', async ({ page, request }) => {
    /*
      Resolved from live data rather than hardcoded. The event page is the single most
      important screen in the product and the one most likely to regress, and a hardcoded
      slug rots the first time the seed changes — which is how a route quietly stops being
      covered while the suite still reports green.
    */
    const slug = await firstEventSlug(request);
    test.skip(!slug, 'no published event in this environment');
    await scan(page, `${CUSTOMER}/events/${slug}`);
  });
});

test.describe('accessibility sweep: the organizer console', () => {
  test.describe.configure({ mode: 'serial' });
  let tokens: Awaited<ReturnType<typeof apiLogin>>;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, 'owner@eticketsgo.test');
  });
  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  for (const route of ORGANIZER_ROUTES) {
    test(`organizer ${route}`, async ({ page }) => {
      await scan(page, `${ORGANIZER}${route}`);
    });
  }

  test('a table row is still openable from the keyboard, and has a real name', async ({ page }) => {
    /*
      The other half of the `nested-interactive` fix, and the half a scan cannot check.

      Table rows used to be `<tr role="button" tabindex="0">` containing their own Edit and
      Approve buttons — a button containing buttons. Removing the role fixes the rule and
      would, on its own, have left keyboard users with NO way to open a row at all, because
      the first cell was plain text. That is a worse product that passes more rules.

      So the control moved INTO the first cell, where it has an accessible name: the row's
      own title, rather than "button" followed by the entire row read aloud. This asserts
      both halves — that the control exists and is reachable, and that it is named.
    */
    await page.goto(`${ORGANIZER}/organizer/events`, { waitUntil: 'networkidle' });
    const firstRow = page.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 30_000 });

    const cellText = await firstRow.locator('td').first().innerText();
    const title = cellText.split('\n')[0];
    /*
      Matched as a plain substring, not a pattern. Row titles carry dates, dots and brackets,
      and handing one to `RegExp` turns "Free Talk 1787820625017" into something that matches
      almost anything — which would let this pass against the wrong control.
    */
    const opener = firstRow.getByRole('button', { name: title.slice(0, 20), exact: false });
    await expect(opener, 'the first cell should carry a named control').toBeVisible();

    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/organizer\/events\/[^/]+$/, { timeout: 30_000 });
  });
});

test.describe('accessibility sweep: the admin console', () => {
  test.describe.configure({ mode: 'serial' });
  let tokens: Awaited<ReturnType<typeof apiLogin>>;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, 'admin@eticketsgo.test');
  });
  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  for (const route of ADMIN_ROUTES) {
    test(`admin ${route}`, async ({ page }) => {
      await scan(page, `${ADMIN}${route}`);
    });
  }
});

/** The slug of any published event, or undefined in an environment with none. */
async function firstEventSlug(request: APIRequestContext): Promise<string | undefined> {
  const res = await request.get(`${API}/public/events?page=1&pageSize=1`);
  if (!res.ok()) return undefined;
  const body = await res.json();
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  return rows[0]?.slug;
}
