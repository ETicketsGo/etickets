import { expect, test, type Page } from '@playwright/test';
import { ADMIN, ORGANIZER, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

/**
 * The two Overviews paint once and stay put.
 *
 * The organizer Overview used to choose its phone layout after hydration (`matchMedia` in a hook),
 * so a phone painted the desktop order and then jumped; and both Overviews grew as each read
 * landed - the setup panel, the queues, the welcome's date pill - pushing everything under them
 * down (a cumulative layout shift of ~0.15 on the organizer page and ~0.48 on the admin page at
 * 768px). Each now shows one skeleton shaped like the page and then the page whole, with the
 * arrangement per width done by CSS.
 *
 * Measured with the browser's own Layout Instability API: the sum of `layout-shift` entries that
 * were not caused by input. Good is under 0.1; the bar here is 0.02.
 */

const CLS_LIMIT = 0.02;

async function watchShifts(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
        if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

async function settledShift(page: Page): Promise<number> {
  await page.waitForLoadState('networkidle');
  // Late pills (the sale state) and images: give them a moment to land, and count what they move.
  await page.waitForTimeout(1_500);
  return page.evaluate(() => (window as unknown as { __cls: number }).__cls);
}

test.describe('the Overviews do not move under the reader', () => {
  let owner: AuthTokens;
  let admin: AuthTokens;

  test.beforeAll(async ({ request }) => {
    owner = await apiLogin(request, 'owner@eticketsgo.test');
    admin = await apiLogin(request, 'admin@eticketsgo.test');
  });

  for (const width of [390, 768]) {
    test(`organizer Overview at ${width}px: no layout shift, and "Show more" stays put`, async ({
      page,
      context,
    }) => {
      await seedBrowserAuth(context, owner);
      await page.setViewportSize({ width, height: 900 });
      await watchShifts(page);
      await page.goto(`${ORGANIZER}/organizer`);
      await expect(page.getByRole('heading', { level: 1, name: /^Welcome back/ })).toBeVisible({
        timeout: 30_000,
      });
      expect(await settledShift(page)).toBeLessThan(CLS_LIMIT);

      // One fold button is shown at each of these widths (the menu has its own, by other names).
      const more = page.getByRole('button', { name: /^Show more (Calendar|Sales)/ });
      await expect(more).toHaveCount(1);
      await more.scrollIntoViewIfNeeded();
      const before = (await more.boundingBox())!.y;
      await more.click();
      const less = page.getByRole('button', { name: /^Show less/ });
      await expect(less).toHaveAttribute('aria-expanded', 'true');
      expect(Math.abs((await less.boundingBox())!.y - before)).toBeLessThanOrEqual(1);
      // What it opened is there: the money in detail at both widths.
      await expect(page.getByRole('heading', { name: 'Gross to net' })).toBeVisible();
    });

    test(`admin Overview at ${width}px: no layout shift`, async ({ page, context }) => {
      await seedBrowserAuth(context, admin);
      await page.setViewportSize({ width, height: 900 });
      await watchShifts(page);
      await page.goto(`${ADMIN}/admin`);
      await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible({
        timeout: 30_000,
      });
      expect(await settledShift(page)).toBeLessThan(CLS_LIMIT);
    });
  }
});
