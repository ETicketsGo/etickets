import { test, expect, devices, type Page } from '@playwright/test';
import { CUSTOMER, uniqueEmail } from './helpers';
import { openPaidEvent } from './pick-event';

/**
 * The storefront on a phone.
 *
 * Reported by the owner, who installed the QA storefront as an Android app and bought a ticket on
 * it: "once I open any event I need to scroll a lot to reach to see select no of tickets and
 * payment options, even frequently asked questions are coming before ticket selection which is not
 * good user experience".
 *
 * Both halves of that are measurable, and neither shows up in a test run at desktop width - which
 * is why every other spec in this suite missed them. This one runs at a real phone size and
 * measures what the buyer actually has to do.
 *
 * ── THE RULE THESE PROTECT ─────────────────────────────────────────────────────────
 * The page must not scroll sideways, and the thing the visitor came to do must be reachable
 * without hunting for it. Everything else on an event page is reference material.
 */
test.use({ ...devices['Pixel 7'], viewport: { width: 411, height: 852 } });

/** How far down the page a heading sits, in pixels from the top of the document. */
async function headingOffsets(page: Page): Promise<{ text: string; y: number }[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('main h2, main h3'))
      .map((el) => ({
        text: (el.textContent ?? '').trim(),
        y: Math.round(el.getBoundingClientRect().top + window.scrollY),
      }))
      .filter((h) => h.text)
      .sort((a, b) => a.y - b.y),
  );
}

test.describe('the storefront on a phone', () => {
  test('1: no page scrolls sideways', async ({ page }) => {
    /*
      A 12px sideways scroll on the event page, caused by the optional "Your state" dropdown: a
      `<select>` cannot be narrower than its widest option, "Andaman and Nicobar Islands", and it
      sat in a grid item, which defaults to `min-width: auto`. That minimum propagated up and made
      the whole 411px page 423px wide. It is the kind of thing nobody reports as a bug and
      everybody feels - the page drifts under your thumb while you read.
    */
    const pages = ['/', '/events', '/movies', '/help', '/booking/find', '/login'];
    for (const path of pages) {
      await page.goto(`${CUSTOMER}${path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(600);
      const { scrollW, clientW } = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(scrollW, `${path} scrolls sideways`).toBeLessThanOrEqual(clientW + 1);
    }
  });

  test('2: an event page does not scroll sideways either', async ({ page }) => {
    await page.goto(`${CUSTOMER}/events`);
    await openPaidEvent(page);
    await page.waitForTimeout(800);
    const { scrollW, clientW } = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    expect(scrollW, 'the event page scrolls sideways').toBeLessThanOrEqual(clientW + 1);
  });

  test('3: buying comes before reading about it', async ({ page }) => {
    await page.goto(`${CUSTOMER}/events`);
    await openPaidEvent(page);
    await page.waitForTimeout(800);

    const headings = await headingOffsets(page);
    const find = (re: RegExp) => headings.find((h) => re.test(h.text));
    const buy = find(/select tickets|choose your seats/i);
    const faq = find(/frequently asked/i);
    const reviews = find(/ratings & reviews|reviews/i);
    const venue = find(/^venue$/i);

    expect(buy, 'the event page offers a way to buy').toBeTruthy();

    // The complaint, exactly: the FAQ was above the tickets.
    if (faq) expect(buy!.y, 'the FAQ comes before ticket selection').toBeLessThan(faq.y);
    if (reviews) expect(buy!.y, 'the reviews come before ticket selection').toBeLessThan(reviews.y);
    /*
      And the venue, which is the next thing down after the sessions. Reference material about
      where the show is belongs after the decision it does not affect - a buyer picking a showtime
      wants the tickets next, not an address.
    */
    if (venue) expect(buy!.y, 'the venue comes before ticket selection').toBeLessThan(venue.y);

    /*
      Within one screen of the fold. Anything further and it is being hunted for rather than seen.
      Deliberately generous: this is protecting against the regression that puts it four screens
      down, not pinning a pixel that a longer event title would move.
    */
    const viewport = page.viewportSize()!.height;
    expect(buy!.y, 'ticket selection is far down the page').toBeLessThan(viewport * 1.2);

    /*
      ── AND WHILE THIS CARD IS OPEN: ONE FIGURE, ONE SHAPE ─────────────────────────
      The other half of the same report - "its good to show 499.00". The ticket rows and the
      breakdown under them each decided their own decimals, so the card printed "Rs 200" directly
      above "Rs 200.00": one figure, twice, a finger apart.

      Asserted here rather than in a test of its own because it needs exactly what this test
      already has - a paid event, open. A separate test meant a fourth checkout against a shared
      pool of seeded events, and on a full-suite run it found the catalogue momentarily empty and
      failed for a reason that had nothing to do with money.

      Scoped to the booking card on purpose. A listing price elsewhere is a different document and
      is meant to stay clean: "From Rs 200" on a recommendation card is right, and making the whole
      page agree would put paise on every price in the catalogue.
    */
    const picker = page.locator('select[aria-label^="Quantity"]').first();
    if (await picker.isVisible()) {
      await picker.selectOption('1');
      // The quote is fetched when the cart changes, and the fees are what introduce paise.
      await expect(page.getByText(/^Total$/).first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1500);

      const amounts = await page.evaluate(() => {
        const card = Array.from(document.querySelectorAll('div')).find(
          (d) =>
            d.querySelector('select[aria-label^="Quantity"]') &&
            /Total/.test(d.textContent ?? '') &&
            !Array.from(d.children).some(
              (c) =>
                c.querySelector?.('select[aria-label^="Quantity"]') &&
                /Total/.test(c.textContent ?? ''),
            ),
        );
        return (card?.innerText ?? '').match(/\u20b9[\d,]+(?:\.\d+)?/g) ?? [];
      });

      expect(amounts.length, 'the booking card shows money').toBeGreaterThan(1);
      const withPaise = amounts.filter((x) => x.includes('.')).length;
      expect(
        withPaise === 0 || withPaise === amounts.length,
        `the booking card mixes decimal shapes: ${amounts.join(' ')}`,
      ).toBe(true);
    }
  });

  test('4: the desktop layout is still two columns', async ({ page }) => {
    /*
      The ordering above is done with `order` inside a grid, dropped from `lg` up. That is easy to
      get wrong in a way no phone-sized test would notice, and the owner's standing instruction is
      that these fixes must not disturb the web - so the desktop shape is asserted here, beside the
      change that could break it.
    */
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${CUSTOMER}/events`);
    await openPaidEvent(page);
    await page.waitForTimeout(800);

    const layout = await page.evaluate(() => {
      const grid = document.querySelector('main > div > div.grid');
      if (!grid) return null;
      const cs = getComputedStyle(grid);
      const wrapper = grid.firstElementChild;
      return {
        columns: cs.gridTemplateColumns.split(' ').length,
        // On a wide screen the left column is a block again, not dissolved into the grid.
        wrapperDisplay: wrapper ? getComputedStyle(wrapper).display : null,
        // And every `order` is back to its default, so the DOM order is what is drawn.
        orders: Array.from(grid.querySelectorAll(':scope > *, :scope > * > *')).map(
          (el) => getComputedStyle(el).order,
        ),
      };
    });
    expect(layout, 'the event page has its two-column grid').toBeTruthy();
    expect(layout!.columns, 'desktop is not three columns').toBe(3);
    expect(layout!.wrapperDisplay, 'the left column is dissolved on desktop').toBe('block');
    expect(
      layout!.orders.every((o) => o === '0'),
      `a mobile order leaked into desktop: ${layout!.orders.join(',')}`,
    ).toBe(true);
  });

  test('5: the payment step is not mostly footer', async ({ page }) => {
    /*
      Measured on the phone the owner bought a ticket on: Review & pay was about 1900px tall and a
      little under half of that was the site footer - three columns of links whose entire job is to
      send the reader somewhere other than the payment they came for.

      Help and the three legal documents stay, because somebody deciding whether to pay is exactly
      who needs the refund policy to hand. What goes is the shopping menu.
    */
    await page.goto(`${CUSTOMER}/events`);
    await openPaidEvent(page);
    await page.locator('select[aria-label^="Quantity"]').first().selectOption('1');
    await page.getByLabel('Your name').fill('Footer Check');
    await page.getByLabel('Email', { exact: true }).fill(uniqueEmail('footer'));
    await page.getByRole('button', { name: /Continue to payment/ }).click();
    await expect(page).toHaveURL(/\/booking\/.+\/payment/, { timeout: 20_000 });
    await page.waitForTimeout(800);

    const footer = await page.evaluate(() => {
      const f = document.querySelector('footer');
      if (!f) return null;
      return {
        share: f.getBoundingClientRect().height / document.body.scrollHeight,
        links: Array.from(f.querySelectorAll('a'))
          .filter((a) => a.getBoundingClientRect().height > 0)
          .map((a) => (a.textContent ?? '').trim()),
      };
    });
    expect(footer, 'the payment page has a footer').toBeTruthy();
    expect(footer!.share, 'the footer is most of the payment page').toBeLessThan(0.25);

    // What must still be reachable from the till.
    for (const needed of [/terms/i, /privacy/i, /refund/i, /help/i]) {
      expect(
        footer!.links.some((l) => needed.test(l)),
        `the payment footer dropped ${needed} - links were: ${footer!.links.join(', ')}`,
      ).toBe(true);
    }
    // And what must not: nothing that sends a buyer shopping again.
    for (const gone of [/browse events/i, /^movies$/i]) {
      expect(
        footer!.links.some((l) => gone.test(l)),
        `${gone} is still under the payment button`,
      ).toBe(false);
    }
  });

  test('6: every other page keeps its full footer', async ({ page }) => {
    // The compact footer is scoped to the payment route. A global change here would quietly strip
    // the site's navigation from every phone.
    await page.goto(`${CUSTOMER}/events`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('footer a')).map((a) => (a.textContent ?? '').trim()),
    );
    expect(
      links.some((l) => /browse events/i.test(l)),
      'the browse page lost its footer',
    ).toBe(true);
  });
});
