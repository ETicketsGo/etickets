import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, CUSTOMER, apiLogin, uniqueEmail } from './helpers';

/**
 * Round L: the customer-experience items left open by the pilot journey review.
 *
 * Each test proves one behaviour against a running stack, on fixtures this file creates and
 * names itself. Nothing here touches a seeded event, so a run never changes what another suite
 * sees.
 *
 *   1 tap targets      2 sticky "Continue to payment"   3 sold-out notice
 *   4 guest revisit    5 hero time zone                 6 images
 *   7 axe, 390 + 1440  8 build identifier
 */

/** One transparent pixel: enough for the API to cut its copies, small enough to commit. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Fixture {
  slug: string;
  sessionId: string;
  ticketTypeId: string;
  eventId: string;
}

let paid: Fixture;
let soldOut: Fixture;
let organizerAuth: { Authorization: string };

/** A published paid event with one ticket type, an image, and `quantity` tickets. */
async function makeEvent(
  request: APIRequestContext,
  label: string,
  quantity: number,
): Promise<Fixture> {
  const stamp = Date.now();
  const orgs = await (await request.get(`${API}/organizations`, { headers: organizerAuth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const venues = await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, {
      headers: organizerAuth,
    })
  ).json();
  const list = (Array.isArray(venues) ? venues : venues.data) as {
    id: string;
    timezone?: string | null;
    city?: string;
  }[];
  // A venue with a clock, so the time on the page can be checked for its zone.
  const venue = list.find((v) => v.timezone) ?? list[0];

  const event = await (
    await request.post(`${API}/events`, {
      headers: organizerAuth,
      data: {
        organizationId,
        title: `L-TEST ${label} ${stamp}`,
        category: 'Community',
        venueId: venue.id,
        feeMode: 'CUSTOMER_PAYS',
      },
    })
  ).json();
  expect(event.id, `event creation failed: ${JSON.stringify(event)}`).toBeTruthy();

  const session = await (
    await request.post(`${API}/events/${event.id}/sessions`, {
      headers: organizerAuth,
      data: {
        startsAt: new Date(Date.now() + 40 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 40 * 86_400_000 + 2 * 3_600_000).toISOString(),
      },
    })
  ).json();
  const ticketType = await (
    await request.post(`${API}/events/ticket-types`, {
      headers: organizerAuth,
      data: {
        eventSessionId: session.id,
        name: 'General',
        priceMinor: 50000,
        quantityTotal: quantity,
        maxPerOrder: 4,
      },
    })
  ).json();
  await request.post(`${API}/events/${event.id}/images`, {
    headers: organizerAuth,
    multipart: { file: { name: 'l.png', mimeType: 'image/png', buffer: PNG } },
  });
  await request.post(`${API}/events/${event.id}/submit`, { headers: organizerAuth });
  const admin = await apiLogin(request, 'admin@eticketsgo.test');
  await request.post(`${API}/admin/events/${event.id}/review`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { decision: 'APPROVE' },
  });
  return {
    slug: event.slug,
    sessionId: session.id,
    ticketTypeId: ticketType.id,
    eventId: event.id,
  };
}

test.beforeAll(async ({ request }) => {
  const { accessToken } = await apiLogin(request, 'owner@eticketsgo.test');
  organizerAuth = { Authorization: `Bearer ${accessToken}` };
  paid = await makeEvent(request, 'paid', 50);
  soldOut = await makeEvent(request, 'sold out', 1);

  // Buy the one ticket there is, so the date has nothing left.
  const email = uniqueEmail('l_soldout');
  await request.post(`${API}/auth/register`, {
    data: { email, password: 'Blue-Lantern-Harbour-47', fullName: 'L Sold Out' },
  });
  const buyer = await apiLogin(request, email, 'Blue-Lantern-Harbour-47');
  const booking = await request.post(`${API}/bookings`, {
    headers: { Authorization: `Bearer ${buyer.accessToken}` },
    data: {
      eventSessionId: soldOut.sessionId,
      items: [{ ticketTypeId: soldOut.ticketTypeId, quantity: 1 }],
      buyerName: 'L Sold Out',
      buyerEmail: email,
    },
  });
  expect(booking.ok(), `holding the last ticket failed: ${await booking.text()}`).toBe(true);
});

test.afterAll(async ({ request }) => {
  // An event with no bookings can be deleted; the sold-out one holds a booking and is left,
  // named "L-TEST" so it is recognisable.
  if (paid) await request.delete(`${API}/events/${paid.eventId}`, { headers: organizerAuth });
});

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function goToEvent(page: Page, fx: Fixture): Promise<void> {
  await page.goto(`${CUSTOMER}/events/${fx.slug}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
}

test.describe('on a phone', () => {
  test.use(PHONE);

  test('1: primary controls are 44px, and nothing interactive is under 24px', async ({ page }) => {
    await goToEvent(page, paid);
    const sizes = await page.evaluate(() => {
      const visible = (e: Element) => {
        const r = e.getBoundingClientRect();
        const s = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const box = (selector: string) => {
        const e = Array.from(document.querySelectorAll(selector)).find(visible);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      };
      const under24 = Array.from(
        document.querySelectorAll('a[href],button,select,input:not([type=hidden]),summary'),
      )
        .filter(visible)
        // The skip link is 1px until focused, by design.
        .filter((e) => !(e instanceof HTMLAnchorElement && e.getAttribute('href') === '#main'))
        // WCAG 2.5.8 exempts a link that sits inside a sentence; its line box is the target.
        .filter((e) => getComputedStyle(e).display !== 'inline')
        .map((e) => ({
          name: (e.textContent ?? '').trim().slice(0, 30),
          r: e.getBoundingClientRect(),
        }))
        .filter((x) => x.r.width < 24 || x.r.height < 24)
        .map((x) => `${x.name} ${Math.round(x.r.width)}x${Math.round(x.r.height)}`);
      return {
        logo: box('a[aria-label="ETicketsGo home"]'),
        signIn: box('header a[href$="/login"]'),
        language: box('header select'),
        quantity: box('select[aria-label^="Quantity"]'),
        footerLink: box('footer ul a'),
        under24,
      };
    });
    for (const [name, size] of Object.entries(sizes)) {
      if (name === 'under24') continue;
      expect(size, `${name} is on the page`).toBeTruthy();
      expect((size as { h: number }).h, `${name} is at least 44px tall`).toBeGreaterThanOrEqual(44);
    }
    expect(sizes.under24, 'controls under 24x24 CSS px').toEqual([]);

    const share = await page.getByRole('button', { name: /^Share/ }).boundingBox();
    expect(share!.height, 'Share is at least 44px tall').toBeGreaterThanOrEqual(44);
  });

  test('2: a sticky Continue appears once tickets are chosen, and leaves when the real one shows', async ({
    page,
  }) => {
    await goToEvent(page, paid);
    const sticky = page.getByTestId('sticky-continue');
    await expect(sticky, 'nothing chosen, nothing sticky').toHaveCount(0);

    const quantity = page.locator('select[aria-label^="Quantity"]').first();
    await quantity.selectOption('2');
    await expect(sticky).toBeVisible();
    await expect(sticky).toContainText('2 tickets');

    // Above the bottom navigation, not under it, and clear of the gesture bar.
    const bar = (await sticky.boundingBox())!;
    const nav = (await page.locator('nav[aria-label], nav').last().boundingBox())!;
    expect(bar.y + bar.height, 'the bar sits above the bottom navigation').toBeLessThanOrEqual(
      nav.y + 1,
    );
    const bottom = await sticky.evaluate((e) => getComputedStyle(e).bottom);
    expect(bottom, 'bottom offset is the nav height plus the safe-area inset').toBe('56px');

    // Pressing it with the guest form empty must not skip validation: focus lands on the first
    // empty field and the bar does not cover it.
    await sticky.locator('button').click({ force: true });
    const name = page.getByLabel('Your name');
    await expect(name).toBeFocused();
    const field = (await name.boundingBox())!;
    // Either the bar has left (the field is next to the real button) or it is clear of the field.
    if ((await sticky.count()) > 0) {
      const barNow = (await sticky.boundingBox({ timeout: 2_000 }).catch(() => null)) ?? {
        y: Infinity,
      };
      expect(field.y + field.height, 'the focused field is not under the bar').toBeLessThanOrEqual(
        barNow.y + 1,
      );
    }

    // The card's own button takes over once it is on screen: one Continue, not two.
    const own = page.getByRole('button', { name: /Continue to payment/ });
    await own.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await expect(sticky).toHaveCount(0);

    // And it works: the same handler, so a valid form goes to payment.
    await name.fill('L Sticky Buyer');
    await page.getByLabel('Email', { exact: true }).fill(uniqueEmail('l_sticky'));
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(sticky).toBeVisible();
    await sticky.locator('button').click({ force: true });
    await expect(page).toHaveURL(/\/booking\/[^/]+\/payment/, { timeout: 30_000 });
  });

  test('3: a sold-out event says so once, and offers nothing that cannot work', async ({
    page,
  }) => {
    await goToEvent(page, soldOut);
    const notice = page.getByTestId('event-sold-out');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('This event is sold out');
    await expect(page.getByRole('button', { name: /Continue to payment/ })).toHaveCount(0);
    await expect(page.getByTestId('sticky-continue')).toHaveCount(0);
    // An event with tickets left shows no notice.
    await goToEvent(page, paid);
    await expect(page.getByTestId('event-sold-out')).toHaveCount(0);
  });

  test('4: opening a booking this browser cancelled says it was cancelled', async ({ page }) => {
    await goToEvent(page, paid);
    await page.locator('select[aria-label^="Quantity"]').first().selectOption('1');
    await page.getByLabel('Your name').fill('L Cancel Guest');
    await page.getByLabel('Email', { exact: true }).fill(uniqueEmail('l_cancel'));
    await page.getByRole('button', { name: /Continue to payment/ }).click();
    await expect(page).toHaveURL(/\/booking\/([^/]+)\/payment/, { timeout: 30_000 });
    const id = /\/booking\/([^/]+)\/payment/.exec(page.url())![1];

    await page.getByRole('button', { name: 'Cancel booking' }).click();
    await page.getByRole('button', { name: 'Yes, cancel it' }).click();
    await expect(page).toHaveURL(/\/(en)?\/?$/, { timeout: 30_000 });

    await page.goto(`${CUSTOMER}/booking/${id}/confirmation`);
    await expect(page.getByRole('heading', { name: 'You cancelled this booking' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('not open in this browser')).toHaveCount(0);
    await expect(page.locator('#main').getByRole('link', { name: 'Browse events' })).toBeVisible();

    // Another browser never cancelled it, so it still gets the access message.
    const other = await page.context().browser()!.newContext();
    const stranger = await other.newPage();
    await stranger.goto(`${CUSTOMER}/booking/${id}/confirmation`);
    await expect(stranger.getByText('This booking is not open in this browser')).toBeVisible({
      timeout: 20_000,
    });
    await other.close();
  });
});

test('5: the hero time names the venue time zone, as the Sessions list does', async ({ page }) => {
  await goToEvent(page, paid);
  const zone = /\((IST|GMT[+-]\d{1,2}(:\d{2})?|[A-Z]{2,5})\)/;
  const facts = page.locator('main ul li', { hasText: /\d{4}.*\d:\d{2}/ }).first();
  await expect(facts).toContainText(zone);
});

test('6: card images state their size, and only the first ones load at once', async ({ page }) => {
  await page.goto(`${CUSTOMER}/events`);
  const cards = page.locator('a[href^="/events/"] img');
  await expect(cards.first()).toBeAttached({ timeout: 30_000 });
  const report = await cards.evaluateAll((imgs) =>
    imgs.map((i) => ({
      w: i.getAttribute('width'),
      h: i.getAttribute('height'),
      loading: (i as HTMLImageElement).loading,
      priority: i.getAttribute('fetchpriority'),
    })),
  );
  expect(report.length).toBeGreaterThan(0);
  for (const image of report) {
    expect(image.w, 'width attribute').toBeTruthy();
    expect(image.h, 'height attribute').toBeTruthy();
  }
  expect(report.filter((i) => i.priority === 'high').length).toBeLessThanOrEqual(2);
  // Everything after the first two is lazy.
  for (const image of report.slice(2)) expect(image.loading).toBe('lazy');
});

test('6b: the event hero is the priority image and has a reserved box', async ({ page }) => {
  await goToEvent(page, paid);
  const hero = page.locator('main button[aria-label] img').first();
  await expect(hero).toBeAttached();
  expect(await hero.getAttribute('width')).toBe('1280');
  expect(await hero.getAttribute('height')).toBe('720');
  expect(await hero.getAttribute('fetchpriority')).toBe('high');
});

test('8: the build identifier is in the meta tag and the footer, and /api/health agrees', async ({
  page,
  request,
}) => {
  const health = await (await request.get(`${CUSTOMER}/api/health`)).json();
  await page.goto(`${CUSTOMER}/events`);
  const meta = await page.locator('meta[name="build-id"]').getAttribute('content');
  if (health.build) {
    expect(meta).toBe(health.build);
    await expect(page.getByTestId('build-id').first()).toContainText(health.build);
  } else {
    // Local development: the platform sets no commit, so nothing is claimed.
    expect(meta).toBeNull();
    await expect(page.getByTestId('build-id')).toHaveCount(0);
  }
});

for (const [label, size] of [
  ['390', { width: 390, height: 844 }],
  ['1440', { width: 1440, height: 900 }],
] as const) {
  test(`7: axe finds no serious or critical issue at ${label}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: size, timezoneId: 'Asia/Kolkata' });
    const page = await context.newPage();
    const routes = ['/', '/events', `/events/${paid.slug}`, `/events/${soldOut.slug}`, '/login'];
    const failures: string[] = [];
    for (const route of routes) {
      await page.goto(`${CUSTOMER}${route}`, { waitUntil: 'networkidle' });
      if (route.startsWith('/events/')) {
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        // The sticky bar is part of the page once tickets are chosen; scan that state too.
        const quantity = page.locator('select[aria-label^="Quantity"]').first();
        if (await quantity.isEnabled().catch(() => false)) await quantity.selectOption('1');
      }
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      for (const v of result.violations.filter((x) =>
        ['serious', 'critical'].includes(x.impact ?? ''),
      )) {
        failures.push(`${route}: ${v.id} (${v.impact}) ${v.nodes.length} node(s)`);
      }
    }
    await context.close();
    expect(failures).toEqual([]);
  });
}
