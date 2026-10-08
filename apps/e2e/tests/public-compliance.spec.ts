import { test, expect } from '@playwright/test';
import { CUSTOMER } from './helpers';

/**
 * The public compliance surface a messaging reviewer, a buyer and an auditor all land on.
 *
 * -- WHY THIS IS AN E2E TEST AND NOT A UNIT TEST --------------------------------------
 * Every one of these properties is about the rendered, unauthenticated site. Two of them
 * have already failed in exactly the way a unit test cannot see: the text-message page was
 * linked only from the marketing footer, which the home page does not render, so it existed
 * and was unreachable from the front door; and a call to action inside `Prose` rendered its
 * label in the same blue as its own background. The build was green for both.
 *
 * -- WHAT IT REFUSES TO ALLOW ---------------------------------------------------------
 * Internal drafting language on a public page, a legal page that needs a login, a country
 * whose supplement leaks into another country's document, and a legal page that renders
 * nothing because the market has no supplement of its own.
 */

const LEGAL_PAGES = ['/terms', '/privacy', '/refunds', '/sms', '/cookies'];

/** Language that belongs in a pull request, never on the production site. */
const INTERNAL_ONLY = [
  /not been reviewed by a lawyer/i,
  /not legally binding/i,
  /legal counsel must review/i,
  /lawyer has not yet reviewed/i,
  /to be drafted by counsel/i,
  /in this demo/i,
  /\(placeholder\)/i,
  /legal review pending/i,
  /draft policy/i,
  /\bTODO\b/,
  /localhost/i,
  /railway\.app/i,
  /eticketsgo\.example/i,
];

test.describe('the public compliance surface', () => {
  test('every legal page is reachable without signing in', async ({ page }) => {
    for (const path of LEGAL_PAGES) {
      const res = await page.goto(`${CUSTOMER}${path}`);
      expect(res?.status(), `${path} must be public`).toBe(200);
      // A redirect to a login screen is a 200 on the wrong page, so check where we landed.
      expect(page.url(), `${path} must not bounce to sign-in`).not.toMatch(/\/login/);
    }
  });

  test('no internal drafting language is published anywhere', async ({ page }) => {
    for (const path of LEGAL_PAGES) {
      await page.goto(`${CUSTOMER}${path}`);
      const text = await page.locator('body').innerText();
      for (const pattern of INTERNAL_ONLY) {
        expect(text, `${path} must not publish ${pattern.source}`).not.toMatch(pattern);
      }
    }
  });

  test('the text-message programme discloses what a reviewer is told to look for', async ({
    page,
  }) => {
    await page.goto(`${CUSTOMER}/sms`);
    const text = await page.locator('body').innerText();

    expect(text).toMatch(/ETicketsGo text messages/i);
    expect(text).toMatch(/Message frequency depends/i);
    expect(text).toMatch(/Message and data rates may apply/i);
    expect(text).toMatch(/Reply\s+STOP/i);
    expect(text).toMatch(/Reply\s+HELP/i);
    expect(text).toMatch(/not a condition of buying a ticket/i);
    expect(text).toMatch(/do not sell your mobile number/i);

    // The policy links must exist as links, not merely as words.
    await expect(page.locator('a[href$="/privacy"]').first()).toBeVisible();
    await expect(page.locator('a[href$="/terms"]').first()).toBeVisible();
  });

  test('a reviewer starting at the home page can reach what A2P review needs', async ({ page }) => {
    /*
      The regression this exists for: the text-message page was once linked only from the
      marketing footer, which the home page does not render, so it was invisible from the one
      place a reviewer starts.

      The footer deliberately carries the documents a buyer or a reviewer needs in the moment
      - the programme itself, the terms they are agreeing to, privacy, and refunds - plus the
      Legal Center for everything else. Cookies and the organizer agreement live one click
      deeper, which is where a mature storefront puts them; the Legal Center test below proves
      they are reachable.
    */
    await page.goto(CUSTOMER);
    for (const href of ['/terms', '/privacy', '/refunds', '/sms', '/legal']) {
      await expect(
        page.locator(`a[href$="${href}"]`).first(),
        `the home page must link to ${href}`,
      ).toHaveCount(1);
    }
  });

  test('the Legal Center lists every published document, and each one resolves', async ({
    page,
  }) => {
    const res = await page.goto(`${CUSTOMER}/legal`);
    expect(res?.status()).toBe(200);
    for (const href of [...LEGAL_PAGES, '/organizer-agreement']) {
      const link = page.locator(`a[href$="${href}"]`).first();
      await expect(link, `the Legal Center must list ${href}`).toHaveCount(1);
    }
  });

  test.describe('market-aware policies, with no country control on the document', () => {
    test('no legal document offers a country selector', async ({ page }) => {
      /*
        The correction this block exists for. Twice the documents carried their own
        jurisdiction picker, which put the policy resolver on screen and asked a customer to
        operate it before reading. The market now comes from the one the PRODUCT resolved.
      */
      for (const path of LEGAL_PAGES) {
        await page.goto(`${CUSTOMER}${path}`);
        const text = await page.locator('body').innerText();
        expect(text, `${path} must not ask the reader to pick a country`).not.toMatch(
          /Change region|Applicable to|All other countries/i,
        );
        await expect(
          page.locator('summary', { hasText: /region/i }),
          `${path} must have no region disclosure`,
        ).toHaveCount(0);
      }
    });

    test('no legal page leaks a policy identifier', async ({ page }) => {
      for (const path of LEGAL_PAGES) {
        await page.goto(`${CUSTOMER}${path}`);
        const t = await page.locator('body').innerText();
        expect(t, `${path} must not show a policy id`).not.toMatch(
          /(TERMS|PRIVACY|SMS|REFUNDS|COOKIES)\/[A-Z]+\/v\d/,
        );
        expect(t).toMatch(/Last updated October 6, 2026/);
      }
    });

    test('REMOVING THE SELECTOR DID NOT COLLAPSE EVERY MARKET ONTO ONE POLICY', async ({
      browser,
    }) => {
      /*
        The risk the correction introduced, pinned. A document that silently serves the
        global text to everybody would look identical to a working one on every page this
        suite opens without a market - so the market is set the way the product sets it, by
        cookie, and the India supplement must appear.
      */
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: 'etg_market', value: 'IN', url: CUSTOMER }]);
      const page = await ctx.newPage();
      await page.goto(`${CUSTOMER}/terms`);
      const indiaText = await page.locator('body').innerText();
      expect(indiaText, 'an Indian market must get the India supplement').toMatch(
        /inclusive of GST/i,
      );
      await ctx.close();

      const plain = await browser.newContext();
      const p2 = await plain.newPage();
      await p2.goto(`${CUSTOMER}/terms`);
      const globalText = await p2.locator('body').innerText();
      expect(globalText, 'no market must get the global text').not.toMatch(/inclusive of GST/i);
      await plain.close();
    });

    test('an explicit country in the URL beats the product market', async ({ browser }) => {
      // How the support team shares "the Indian terms" with somebody browsing in the US.
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: 'etg_market', value: 'IN', url: CUSTOMER }]);
      const page = await ctx.newPage();
      await page.goto(`${CUSTOMER}/terms?country=US`);
      expect(await page.locator('body').innerText()).not.toMatch(/inclusive of GST/i);
      await ctx.close();
    });

    test('an unknown market falls back instead of failing', async ({ browser }) => {
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: 'etg_market', value: 'Narnia', url: CUSTOMER }]);
      const page = await ctx.newPage();
      const res = await page.goto(`${CUSTOMER}/terms`);
      expect(res?.status()).toBe(200);
      expect(await page.locator('body').innerText()).toMatch(/1\. Overview/);
      await ctx.close();
    });

    test('states one operator, and claims no per-country contracting entity', async ({ page }) => {
      await page.goto(`${CUSTOMER}/terms`);
      const t = await page.locator('body').innerText();
      expect(t).toContain('operated by DeepTrics LLC');
      expect(t).not.toContain('Deeptrics Software Solution Pvt Ltd');
    });

    test('every document offers a way back to the Legal Center', async ({ page }) => {
      for (const path of LEGAL_PAGES) {
        await page.goto(`${CUSTOMER}${path}`);
        await expect(
          page.locator('a[href$="/legal"]').first(),
          `${path} must link back to the Legal Center`,
        ).toHaveCount(1);
      }
    });
  });

  test('consent records are not exposed publicly', async ({ request }) => {
    // The history endpoint answers a data-subject request, which means it must never answer
    // an anonymous one.
    const res = await request.get(`${CUSTOMER.replace(/\/$/, '')}/api/me/marketing-consent`, {
      failOnStatusCode: false,
    });
    expect([401, 403, 404]).toContain(res.status());
  });
});
