import { test, expect } from '@playwright/test';
import { TICKET_PRINT_CSS } from '@eticketsgo/web-kit';
import { API, CUSTOMER, ORGANIZER, apiLogin, seedBrowserAuth } from './helpers';

/**
 * The printed ticket, verified as PAPER rather than as a page.
 *
 * ── WHY THIS PRINTS TO PDF INSTEAD OF ASSERTING ON THE DOM ─────────────────────────
 * Every bug this file exists to catch is invisible on screen. A print stylesheet that hides
 * the app shell with `visibility: hidden` and lifts the sheet out of flow looks perfect in a
 * browser window and prints exactly one page — absolutely positioned content is removed from
 * the flow the printer paginates, so a three-ticket booking silently produces one ticket. The
 * DOM is identical either way. Only the PDF knows.
 *
 * So this renders the page, prints it the way the browser would, and asserts on the artefact:
 * how many pages came out, and whether the words that matter are on them.
 *
 * `page.pdf()` is Chromium-only, which is fine — it is a proxy for "what does printing do",
 * not a claim about browser support.
 */

/** Roughly how many pages a PDF has, without pulling in a parser. */
function pdfPageCount(pdf: Buffer): number {
  const text = pdf.toString('latin1');
  const byType = text.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
  if (byType > 0) return byType;
  return Number(text.match(/\/Count\s+(\d+)/)?.[1] ?? 0);
}

/*
  There is deliberately no text extractor here.

  The first version searched the raw PDF bytes for words and reported FALSE for text that was
  plainly on the sheet — Chromium compresses the content stream, so the characters are simply
  not there to find. A helper that answers "no" to a question it cannot answer is worse than no
  helper: it fails builds for the wrong reason and teaches people to delete the assertion.

  Page COUNT survives compression, and it is the thing worth asserting anyway — it is what a
  broken print stylesheet gets wrong. What the sheet SAYS is asserted against the DOM, which
  can be read exactly.
*/

test.describe('printing tickets', () => {
  test('a customer prints every ticket in their booking, one per page', async ({
    browser,
    request,
  }) => {
    const tokens = await apiLogin(request, 'customer1@eticketsgo.test');
    const wallet = await (
      await request.get(`${API}/tickets`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
    ).json();
    test.skip(!Array.isArray(wallet) || wallet.length === 0, 'no tickets in this environment');

    // A booking with the most tickets, because one ticket cannot fail a pagination bug.
    const byBooking = new Map<string, number>();
    for (const t of wallet) byBooking.set(t.bookingId, (byBooking.get(t.bookingId) ?? 0) + 1);
    const [bookingId, expected] = [...byBooking.entries()].sort((a, b) => b[1] - a[1])[0];

    const context = await browser.newContext();
    await seedBrowserAuth(context, tokens);
    const page = await context.newPage();
    await page.goto(`${CUSTOMER}/account/bookings/${bookingId}/tickets/print`);

    // The sheet is what should be on the page — and the app shell should not.
    await expect(page.getByText(/Ticket 1 of/)).toBeVisible({ timeout: 20_000 });

    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    const pages = pdfPageCount(pdf);

    /*
      The assertion that catches the bug this file was written for. With the sheet lifted out
      of the document flow this came back as 1 no matter how many tickets the booking had.
    */
    expect(pages).toBe(expected);

    await context.close();
  });

  test('the app shell is not printed', async ({ browser, request }) => {
    const tokens = await apiLogin(request, 'customer1@eticketsgo.test');
    const wallet = await (
      await request.get(`${API}/tickets`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
    ).json();
    test.skip(!Array.isArray(wallet) || wallet.length === 0, 'no tickets in this environment');

    const context = await browser.newContext();
    await seedBrowserAuth(context, tokens);
    const page = await context.newPage();
    await page.goto(`${CUSTOMER}/account/bookings/${wallet[0].bookingId}/tickets/print`);
    await expect(page.getByText(/Ticket 1 of/)).toBeVisible({ timeout: 20_000 });

    /*
      Navigation on a printed ticket is wasted ink and, worse, a leading blank page when it is
      hidden rather than removed. The print route renders no site chrome at all, so the header
      links are simply absent from the document.
    */
    await expect(page.getByRole('link', { name: 'Explore' })).toHaveCount(0);
    await expect(page.getByRole('contentinfo')).toHaveCount(0);

    await context.close();
  });

  /*
    Reported from QA: after the print dialog there was no way back to the tickets, and a saved
    PDF was named after the site's tagline. The PDF button printed the whole page, header and
    bottom navigation over the QR.
  */
  test('the print sheet has a way back, a real file name, and is what PDF opens', async ({
    browser,
    request,
  }) => {
    const tokens = await apiLogin(request, 'customer1@eticketsgo.test');
    const wallet = await (
      await request.get(`${API}/tickets`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
    ).json();
    test.skip(!Array.isArray(wallet) || wallet.length === 0, 'no tickets in this environment');
    const bookingId = wallet[0].bookingId;

    const context = await browser.newContext();
    await seedBrowserAuth(context, tokens);
    const page = await context.newPage();
    /*
      The print dialog cannot be driven from a test. Stubbed so autoPrint does not block — and
      so it records the title at the moment printing starts, which is the name "Save as PDF"
      gives the file. A title that becomes right a moment later names nothing.
    */
    await page.addInitScript(() => {
      const w = window as unknown as { __printTitles: string[] };
      w.__printTitles = [];
      window.print = () => {
        w.__printTitles.push(document.title);
      };
    });
    const printTitles = () =>
      page.evaluate(() => (window as unknown as { __printTitles: string[] }).__printTitles);

    await page.goto(`${CUSTOMER}/account/bookings/${bookingId}/tickets`);
    await page.getByRole('button', { name: 'PDF' }).click();
    await expect(page).toHaveURL(new RegExp(`/account/bookings/${bookingId}/tickets/print$`));
    await expect(page.getByText(/Ticket 1 of/)).toBeVisible({ timeout: 20_000 });

    // Named for the event and booking, which is what "Save as PDF" calls the file.
    await expect(page).toHaveTitle(/ - ETicketsGo tickets?$/);
    expect(await page.title()).not.toMatch(/Sell tickets, check in guests/);

    // A visible button, and a way back.
    await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to tickets' }).click();
    await expect(page).toHaveURL(new RegExp(`/account/bookings/${bookingId}/tickets$`));

    /*
      And on a direct load — a refresh or a bookmark — where Next.js writes the page's own
      title after the sheet has rendered. Setting the title once passed the check above and
      still opened the dialog with the site's tagline here.
    */
    await page.goto(`${CUSTOMER}/account/bookings/${bookingId}/tickets/print`);
    await expect(page.getByRole('link', { name: 'Back to tickets' })).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(async () => (await printTitles()).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    expect((await printTitles()).at(-1)).toMatch(/ - ETicketsGo tickets?$/);

    await context.close();
  });

  test('box office staff print a booking they do not own', async ({ browser, request }) => {
    const staff = await apiLogin(request, 'owner@eticketsgo.test');

    // Find a booking belonging to this organizer's events, the way the door would.
    const customer = await apiLogin(request, 'customer1@eticketsgo.test');
    const wallet = await (
      await request.get(`${API}/tickets`, {
        headers: { Authorization: `Bearer ${customer.accessToken}` },
      })
    ).json();
    test.skip(!Array.isArray(wallet) || wallet.length === 0, 'no tickets in this environment');
    const bookingId = wallet[0].bookingId;

    // The API must allow it on membership, not ownership.
    const res = await request.get(`${API}/tickets/booking/${bookingId}/print`, {
      headers: { Authorization: `Bearer ${staff.accessToken}` },
    });
    test.skip(res.status() === 403, 'seeded organizer does not own this booking’s event');
    expect(res.ok()).toBe(true);
    const tickets = await res.json();
    expect(tickets.length).toBeGreaterThan(0);

    const context = await browser.newContext();
    await seedBrowserAuth(context, staff);
    const page = await context.newPage();
    await page.goto(`${ORGANIZER}/organizer/bookings/${bookingId}/print`);
    // `.first()` because every ticket on the sheet carries the label, which is the point.
    await expect(page.getByText(/Box office copy/).first()).toBeVisible({ timeout: 20_000 });

    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    expect(pdfPageCount(pdf)).toBe(tickets.length);
    // Every page says whose copy it is, so one found later is not mistaken for a customer's
    // own printout. Asserted on the DOM, which can be read exactly.
    await expect(page.getByText(/Box office copy/)).toHaveCount(tickets.length);

    await context.close();
  });

  /*
    ── THE FALSIFICATION, RUN EVERY TIME ─────────────────────────────────────────────
    The tests above assert that N tickets print as N pages. On their own they cannot show that
    the assertion is SENSITIVE — a page count of N could in principle come from anywhere.
    Proving it meant reintroducing the bug, which meant rebuilding the app, which meant the
    proof was done once by hand and never again.

    This does it in one run. The same three tickets are printed twice: once with the real
    `TICKET_PRINT_CSS` this component ships, and once with the page-break rule stripped out.
    With the rule, three pages. Without it, one. If someone deletes the rule, the sheet stops
    paginating and this test says so — and it is asserting on the exported constant, so it is
    always reading whatever the component actually ships.
  */
  test('the page-break rule is what makes one ticket per page', async ({ browser }) => {
    const ticket = (n: number) =>
      `<article class="print-ticket" style="height:300px">Ticket ${n} of 3</article>`;
    const sheet = (css: string) =>
      `<!doctype html><html><head><style>${css}</style></head><body>${[1, 2, 3]
        .map(ticket)
        .join('')}</body></html>`;

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.setContent(sheet(TICKET_PRINT_CSS));
    const withRule = pdfPageCount(await page.pdf({ format: 'A4' }));

    // Exactly one rule removed. Everything else — the markup, the sizes, the other rules —
    // is identical, so the difference in page count can only come from that rule.
    await page.setContent(
      sheet(TICKET_PRINT_CSS.replace('page-break-after: always; break-after: page;', '')),
    );
    const withoutRule = pdfPageCount(await page.pdf({ format: 'A4' }));

    expect(withRule).toBe(3);
    expect(withoutRule).toBe(1);

    await context.close();
  });

  test('a stranger cannot print somebody else’s booking', async ({ request }) => {
    /*
      The QR on the sheet is a bearer credential. Membership of the selling organization is
      what authorises a print, and a customer from another account has neither that nor
      ownership.
    */
    const customer = await apiLogin(request, 'customer1@eticketsgo.test');
    const wallet = await (
      await request.get(`${API}/tickets`, {
        headers: { Authorization: `Bearer ${customer.accessToken}` },
      })
    ).json();
    test.skip(!Array.isArray(wallet) || wallet.length === 0, 'no tickets in this environment');

    const other = await apiLogin(request, 'customer2@eticketsgo.test');
    const res = await request.get(`${API}/tickets/booking/${wallet[0].bookingId}/print`, {
      headers: { Authorization: `Bearer ${other.accessToken}` },
    });
    expect([401, 403]).toContain(res.status());
  });
});
