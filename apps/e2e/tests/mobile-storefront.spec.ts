import { test, expect, devices } from '@playwright/test';
import { CUSTOMER, uniqueEmail } from './helpers';
import { openPaidEvent } from './pick-event';
import { chooseQuantity, quantitySteppers } from './ticket-quantity';

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

  test('3: the first screen offers the way to buy', async ({ page }) => {
    await page.goto(`${CUSTOMER}/events`);
    await openPaidEvent(page);
    await page.waitForTimeout(800);

    /*
      The owner's editorial design (2026-10-19) puts the reservation card AFTER the story on a
      phone. What this test protected - "I need to scroll a lot to reach select no of tickets" -
      is now kept by the first screen itself: "Book tickets" and the lowest price sit under the
      title, and one tap lands on the card.
    */
    await page.evaluate(() => window.scrollTo(0, 0));
    const book = page.getByRole('link', { name: 'Book tickets' });
    await expect(book, 'the first screen offers a way to buy').toBeInViewport();
    await book.click();
    const card = page.locator('#tickets');
    await expect(card).toBeInViewport();
    await expect(
      card.getByRole('heading', { name: /choose your tickets|choose your seats/i }),
    ).toBeVisible();

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
    const picker = quantitySteppers(page).first();
    if (await picker.isVisible()) {
      await chooseQuantity(picker, 1);
      // The quote is fetched when the cart changes, and the fees are what introduce paise.
      await expect(page.getByText(/^Total$/).first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1500);

      const amounts = await page.evaluate(() => {
        // The booking card is a <section> on the brand layer; it used to be a <div>.
        const card = Array.from(document.querySelectorAll('div, section')).find(
          (d) =>
            d.querySelector('[data-quantity-stepper]') &&
            /Total/.test(d.textContent ?? '') &&
            !Array.from(d.children).some(
              (c) =>
                c.querySelector?.('[data-quantity-stepper]') && /Total/.test(c.textContent ?? ''),
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
      On a wide screen the reservation card is the right column beside the story and stays in
      view while it scrolls (owner design 2026-10-19). Asserted here, beside the phone tests,
      because a change for the phone is the easiest way to break it.
    */
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${CUSTOMER}/events`);
    await openPaidEvent(page);
    await page.waitForTimeout(800);

    const layout = await page.evaluate(() => {
      const card = document.getElementById('tickets');
      const grid = card?.closest('.grid');
      if (!card || !grid) return null;
      const story = grid.firstElementChild!.getBoundingClientRect();
      const box = card.getBoundingClientRect();
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        cardRightOfStory: box.left >= story.right,
        sticky: getComputedStyle(card.parentElement!).position,
      };
    });
    expect(layout, 'the event page has its two-column grid').toBeTruthy();
    expect(layout!.columns, 'desktop is two columns').toBe(2);
    expect(layout!.cardRightOfStory, 'the card is the right column').toBe(true);
    expect(layout!.sticky, 'the card stays in view').toBe('sticky');
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
    await chooseQuantity(quantitySteppers(page).first(), 1);
    await page.getByLabel('Your name').fill('Footer Check');
    await page.getByLabel('Email', { exact: true }).fill(uniqueEmail('footer'));
    await page.getByRole('button', { name: /^Reserve/ }).click();
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
