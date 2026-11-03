import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { CUSTOMER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * A storefront page is drawn finished, in the visitor's place, and does not move.
 *
 * Reported by the owner after #548: on a refresh "a different page flashes first" and "content
 * jumps / fills in". Measured (filmstrips, Layout Instability API): every list was fetched by the
 * browser after hydration, first for EVERY country and then again for the visitor's own once the
 * browser had resolved where it was, while a short skeleton page left the footer in the middle of
 * the screen. Browse scored 0.18-0.30 CLS, the seat page 0.22-0.28, My bookings 0.25-0.31.
 *
 * Now the server reads the place from the cookies the browser mirrors (`etg_market`, `etg_city`)
 * and renders the lists itself; `main` is a screen tall, so a page still loading never shows the
 * footer. These pin three things per page:
 *   - no layout shift worth the name (the bar is 0.02; "good" is 0.1),
 *   - no client-side redirect: the URL that was asked for is the one that stays,
 *   - for a returning visitor, the server's HTML already contains what the page shows.
 */

const CLS_LIMIT = 0.02;

async function watch(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number; __moves: string[] };
    w.__cls = 0;
    w.__moves = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
        if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    // A client redirect is a history entry for another path; Next's own same-URL replace is not.
    for (const k of ['pushState', 'replaceState'] as const) {
      const original = history[k];
      history[k] = function (this: History, ...args: Parameters<History['pushState']>) {
        const to = args[2] ? new URL(String(args[2]), location.href).pathname : location.pathname;
        if (to !== location.pathname) w.__moves.push(`${k} ${location.pathname} -> ${to}`);
        return original.apply(this, args);
      } as History['pushState'];
    }
  });
}

async function settled(page: Page): Promise<{ cls: number; moves: string[] }> {
  await page.waitForLoadState('networkidle');
  // Late images and the sale-state reads: give them a moment, and count what they move.
  await page.waitForTimeout(1_500);
  return page.evaluate(() => {
    const w = window as unknown as { __cls: number; __moves: string[] };
    return { cls: w.__cls, moves: w.__moves };
  });
}

/** A visitor who has been here before: the browser resolved India and mirrored it. */
async function returningVisitor(context: BrowserContext) {
  const url = new URL(CUSTOMER);
  await context.addCookies([{ name: 'etg_market', value: 'IN', domain: url.hostname, path: '/' }]);
}

/** The first event the home page links to, so the spec follows whatever the seed holds. */
async function firstEventPath(page: Page): Promise<string> {
  await page.goto(`${CUSTOMER}/events`);
  const href = await page
    .locator('main a[href*="/events/"]')
    .first()
    .getAttribute('href', { timeout: 30_000 });
  return new URL(href!, CUSTOMER).pathname;
}

test.describe('storefront pages paint finished and stay put', () => {
  for (const viewport of [
    { width: 1366, height: 900 },
    { width: 412, height: 839 },
  ]) {
    test(`returning visitor at ${viewport.width}px: home, Browse, an event, Movies, Explore`, async ({
      page,
      context,
    }) => {
      await returningVisitor(context);
      await page.setViewportSize(viewport);
      const event = await firstEventPath(page);
      await watch(page);
      for (const path of ['/', '/events', event, '/movies', '/explore']) {
        await page.goto(`${CUSTOMER}${path}`);
        await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 30_000 });
        const { cls, moves } = await settled(page);
        expect(moves, `${path}: client-side redirect`).toEqual([]);
        expect(new URL(page.url()).pathname, `${path}: stayed`).toBe(path);
        expect(cls, `${path}: layout shift`).toBeLessThan(CLS_LIMIT);
      }
    });
  }

  test('a returning visitor gets the list in the server HTML, not a skeleton to fill', async ({
    page,
    context,
  }) => {
    await returningVisitor(context);
    await page.goto(`${CUSTOMER}/events`);
    const title = (
      await page
        .locator('main a[href*="/events/"] h3, main a[href*="/events/"] h2')
        .first()
        .textContent({
          timeout: 30_000,
        })
    )?.trim();
    expect(title).toBeTruthy();
    // The same request a browser makes, cookie included: the server's answer, before any script.
    const html = await (
      await context.request.get(`${CUSTOMER}/events`, { headers: { cookie: 'etg_market=IN' } })
    ).text();
    // The title's leading words, before any character HTML would escape.
    expect(html).toContain(title!.split(/[^A-Za-z0-9 ]/)[0].trim());
    // React marks text boundaries with comments: "Showing events in <!-- -->India".
    expect(html).toMatch(/Showing events in (<!-- -->)?India/);
  });

  test('a first visit waits for its place and then draws it, without moving', async ({ page }) => {
    await watch(page);
    await page.goto(`${CUSTOMER}/events`);
    await expect(page.getByText('Showing events in India')).toBeVisible({ timeout: 30_000 });
    const { cls, moves } = await settled(page);
    expect(moves).toEqual([]);
    expect(cls).toBeLessThan(CLS_LIMIT);
  });

  /*
    The production case: a first visit (no cookies) from a country with nothing on sale. The
    page drew a placeholder taller than the screen while the browser resolved where it was, then
    the few-line empty state pulled "Before you pay" up into view (0.35 CLS desktop, 0.64 phone
    on PROD). The empty stage drawn after a placeholder is now a screen tall. Europe/London: the
    browser reports the United Kingdom, where the seed sells nothing.
  */
  for (const viewport of [
    { width: 1366, height: 900 },
    { width: 412, height: 839 },
  ]) {
    test(`first visit to an empty market at ${viewport.width}px: home does not move`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport, timezoneId: 'Europe/London' });
      const page = await context.newPage();
      await watch(page);
      await page.goto(`${CUSTOMER}/`);
      await expect(
        page.getByRole('heading', { name: /No events (available|are on sale)/ }),
      ).toBeVisible({
        timeout: 30_000,
      });
      const { cls, moves } = await settled(page);
      expect(moves).toEqual([]);
      expect(cls).toBeLessThan(CLS_LIMIT);
      // What follows the empty stage stays below the fold, where the placeholder had it.
      const trust = await page.locator('#home-trust').boundingBox();
      expect(trust!.y).toBeGreaterThanOrEqual(viewport.height);
      await context.close();
    });
  }

  test('a first visit behind an edge country header is drawn in that market by the server', async ({
    browser,
  }) => {
    // The edge stamps the page request; the browser's own API calls go without it (CORS) and
    // resolve the United Kingdom from the device instead - the same answer.
    const context = await browser.newContext({ timezoneId: 'Europe/London' });
    // No cookie: the server's own answer, before any script.
    const html = await (
      await context.request.get(`${CUSTOMER}/`, { headers: { 'cf-ipcountry': 'GB' } })
    ).text();
    expect(html).toMatch(/No events (available in (<!-- -->)?the United Kingdom|are on sale)/);
    const page = await context.newPage();
    await page.route(`${CUSTOMER}/`, (route) =>
      route.continue({ headers: { ...route.request().headers(), 'cf-ipcountry': 'GB' } }),
    );
    await watch(page);
    await page.goto(`${CUSTOMER}/`);
    const { cls, moves } = await settled(page);
    expect(moves).toEqual([]);
    expect(cls).toBeLessThan(CLS_LIMIT);
    await context.close();
  });

  /*
    The server draws event pages with their event now, and it cannot see the session (the token is
    in localStorage). Anything the page draws differently for a signed-in visitor has to wait for
    hydration, or React throws #418 and redraws the whole page in the browser - which QA caught on
    every signed-in event page (the review form was read from storage during render).
  */
  for (const signedIn of [false, true]) {
    test(`event and list pages hydrate cleanly ${signedIn ? 'signed in' : 'signed out'}`, async ({
      page,
      context,
      request,
    }) => {
      if (signedIn) {
        await seedBrowserAuth(context, await apiLogin(request, 'customer1@eticketsgo.test'));
        const url = new URL(CUSTOMER);
        await context.addCookies([
          { name: 'etg_session', value: '1', domain: url.hostname, path: '/' },
        ]);
      }
      await returningVisitor(context);
      const event = await firstEventPath(page);
      const problems: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error' && /#418|#423|#425|hydrat/i.test(m.text()))
          problems.push(m.text());
      });
      page.on('pageerror', (e) => {
        if (/#418|#423|#425|hydrat/i.test(String(e))) problems.push(String(e));
      });
      for (const path of [event, '/', '/events', '/explore']) {
        await page.goto(`${CUSTOMER}${path}`, { waitUntil: 'networkidle' });
        await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 30_000 });
      }
      expect(problems).toEqual([]);
    });
  }

  test('signed-in account pages hold their place while they load', async ({
    page,
    context,
    request,
  }) => {
    await seedBrowserAuth(context, await apiLogin(request, 'customer1@eticketsgo.test'));
    await returningVisitor(context);
    await page.setViewportSize({ width: 412, height: 839 });
    await watch(page);
    for (const path of ['/account', '/account/bookings', '/account/tickets']) {
      await page.goto(`${CUSTOMER}${path}`);
      await expect(page.locator('main h1').first()).toBeVisible({ timeout: 30_000 });
      const { cls, moves } = await settled(page);
      expect(moves, `${path}: client-side redirect`).toEqual([]);
      expect(cls, `${path}: layout shift`).toBeLessThan(CLS_LIMIT);
    }
  });
});
