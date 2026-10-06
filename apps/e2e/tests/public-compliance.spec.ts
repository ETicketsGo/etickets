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

  test('a reviewer starting at the home page can reach every legal document', async ({ page }) => {
    /*
      The regression this exists for. The home page takes the APP chrome, so a link added
      only to the marketing footer is invisible from the one place a reviewer starts.
    */
    await page.goto(CUSTOMER);
    for (const path of LEGAL_PAGES) {
      await expect(
        page.locator(`a[href$="${path}"]`).first(),
        `the home page must link to ${path}`,
      ).toHaveCount(1);
    }
  });

  test.describe('country-aware policies', () => {
    test('names the market in words, and never the internal policy id', async ({ page }) => {
      /*
        The registry identifier (`TERMS/IN/v1`) is how a consent record names a document. It
        is still resolved and still stored - it is simply not consumer copy, because a page
        that shows it reads as a compliance console rather than a Terms page.
      */
      await page.goto(`${CUSTOMER}/terms?country=IN`);
      const text = await page.locator('body').innerText();
      expect(text).toMatch(/Applicable to\s+India/);
      expect(text).toMatch(/Last updated October 6, 2026/);
      expect(text).not.toMatch(/TERMS\/[A-Z]+\/v\d/);
    });

    test('no legal page leaks a policy identifier', async ({ page }) => {
      for (const path of LEGAL_PAGES) {
        for (const c of ['US', 'IN', 'CA', 'GLOBAL']) {
          await page.goto(`${CUSTOMER}${path}?country=${c}`);
          const t = await page.locator('body').innerText();
          expect(t, `${path}?country=${c} must not show a policy id`).not.toMatch(
            /(TERMS|PRIVACY|SMS|REFUNDS|COOKIES)\/[A-Z]+\/v\d/,
          );
        }
      }
    });

    test('states one operator, and claims no per-country contracting entity', async ({ page }) => {
      /*
        WHICH entity contracts with a buyer in which market is a question about corporate
        structure that this project does not answer, so no page asserts one. An earlier
        version resolved it from the reader's market and told an Indian reader their contract
        was with the Indian company - an assumption dressed as a fact on a legal page.
        docs/compliance/LEGAL-REVIEW-QUESTIONS.md
      */
      for (const c of ['US', 'IN', 'CA', 'GLOBAL']) {
        await page.goto(`${CUSTOMER}/terms?country=${c}`);
        const t = await page.locator('body').innerText();
        expect(t).toContain('operated by DeepTrics LLC');
        expect(t, `country=${c} must not name a second contracting entity`).not.toContain(
          'Deeptrics Software Solution Pvt Ltd',
        );
      }
    });

    test('one country does not leak into another', async ({ page }) => {
      // India's inclusive-GST clause is true of India and wrong everywhere else.
      await page.goto(`${CUSTOMER}/terms?country=US`);
      const text = await page.locator('body').innerText();
      expect(text).not.toMatch(/inclusive of GST/i);
      expect(text).not.toMatch(/available in French/i);
    });

    test('an unknown country falls back instead of failing', async ({ page }) => {
      /*
        A legal page that errors is worse than one showing the text written for everybody,
        so the resolver has a GLOBAL row for every type and normalises anything it does not
        recognise - including something a person typed into the URL.
      */
      const res = await page.goto(`${CUSTOMER}/terms?country=Narnia`);
      expect(res?.status()).toBe(200);
      expect(await page.locator('body').innerText()).toContain('Applicable to all other countries');
    });

    test('the reader can change region, and the control is announced', async ({ page }) => {
      await page.goto(`${CUSTOMER}/terms?country=US`);
      await expect(page.locator('body')).toContainText('Applicable to the United States');

      // Folded away by default: the document is the point, not the jurisdiction picker.
      await page.getByText('Change region').click();
      const options = page.locator('details a');
      await expect(options).toHaveCount(4);
      // Announced, not merely coloured.
      await expect(page.locator('details a[aria-current="page"]')).toHaveCount(1);

      await options.filter({ hasText: 'India' }).click();
      await page.waitForURL(/country=IN/);
      await expect(page.locator('body')).toContainText('Applicable to India');
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
