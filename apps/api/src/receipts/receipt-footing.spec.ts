import { renderReceiptHtml } from './receipt-html';
import type { ReceiptDocument } from './receipt-document';

/**
 * A receipt has to foot.
 *
 * ── THE BUG THIS PINS DOWN ─────────────────────────────────────────────────────────
 * Tax rows sat between the booking fee and the total, which is correct while every tax is
 * ADDED to the price and badly wrong once one is inside it. A real Indian receipt for a ₹100
 * ticket printed:
 *
 *     Subtotal      ₹100.00
 *     Booking fee     ₹7.10
 *     CGST @ 9%       ₹8.17
 *     SGST @ 9%       ₹8.17
 *     Total         ₹107.10
 *
 * Anybody adding that column gets ₹123.44. The tax was already inside the ₹107.10 — the
 * layout invited the reader to add it a second time. A receipt that does not add up is not a
 * presentation preference; it is a document nobody can check, handed to somebody who was
 * charged money.
 *
 * ── WHY THE TESTS ASSERT ON ARITHMETIC, NOT ON MARKUP ──────────────────────────────
 * Whether a row has a class or sits in a `tfoot` is styling. What must be true is that the
 * numbers a reader can see reconcile with the total they were charged, in both tax models.
 */
const doc = (over: Partial<ReceiptDocument> = {}): ReceiptDocument =>
  ({
    version: 1,
    kind: 'RECEIPT',
    number: 'RCT-2026-000011',
    issuedAt: '2026-09-02T00:00:00.000Z',
    currency: 'INR',
    seller: {
      name: 'DeepTrics',
      legalName: null,
      taxRegistrationKind: null,
      taxRegistrationNumber: null,
      address: {
        line1: null,
        line2: null,
        city: null,
        region: null,
        postalCode: null,
        country: null,
      },
      contactEmail: null,
    },
    buyer: { name: 'Srinivas', email: 'buyer@example.test' },
    order: {
      bookingId: 'bk-1',
      reference: 'ETG-IND-2026-000033',
      eventTitle: 'CMDY',
      sessionStartsAt: null,
      venue: 'Madhapur, Hyderabad',
    },
    lines: [
      { description: 'General', quantity: 1, unitPriceMinor: 10_000, lineTotalMinor: 10_000 },
    ],
    totals: {
      subtotalMinor: 10_000,
      discountMinor: 0,
      feeMinor: 710,
      taxMinor: 1_634,
      totalMinor: 10_710,
    },
    taxLines: [
      { label: 'CGST', rateBasisPoints: 900, baseMinor: 9_076, amountMinor: 817 },
      { label: 'SGST', rateBasisPoints: 900, baseMinor: 9_076, amountMinor: 817 },
    ],
    notes: [],
    ...over,
  }) as ReceiptDocument;

/**
 * The totals block as a reader sees it: label, amount, in order.
 *
 * Scraped from the rendered rows rather than from every `₹` in the document — the unit
 * price and the line total repeat the same figures higher up, and a test that adds those in
 * is measuring the table, not the footing.
 */
const totalsRows = (html: string): { label: string; amount: number }[] => {
  const foot = html.slice(html.indexOf('<tfoot>'), html.indexOf('</tfoot>'));
  /*
    Decimals are optional. A receipt whose amounts are all whole rupees now prints "₹105",
    not "₹105.00" — the document decides once, so a column is either all paise or none.
    Requiring `\.\d{2}` matched nothing on such a receipt and the footing check compared two
    empty sums, which is a test that passes by measuring nothing.
  */
  return [
    ...foot.matchAll(/<th colspan="3">(.*?)<\/th><td class="num">₹([\d,]+(?:\.\d{2})?)<\/td>/g),
  ].map((m) => ({ label: m[1], amount: Math.round(Number(m[2].replace(/,/g, '')) * 100) }));
};

describe('receipt footing — tax inside the price', () => {
  it('does NOT list an inclusive tax as if it were another charge', () => {
    /*
      The exact receipt from QA. ₹100 + ₹7.10 = ₹107.10, and the ₹16.34 of GST is already in
      that. The tax is stated — an invoice has to show it — but AFTER the total, never in the
      column a reader adds up.
    */
    const rows = totalsRows(renderReceiptHtml(doc(), 'en'));
    const totalAt = rows.findIndex((r) => r.label === 'Total');
    const taxAt = rows.findIndex((r) => /CGST/.test(r.label));
    expect(taxAt).toBeGreaterThan(totalAt);
  });

  it('says the tax is already in the total, in words', () => {
    // Position alone is subtle. The label has to carry the meaning for somebody scanning.
    const html = renderReceiptHtml(doc(), 'en');
    expect(html).toMatch(/Includes CGST/);
    expect(html).toMatch(/Includes SGST/);
  });

  it('keeps stating the rate and the base the tax was charged on', () => {
    // A GST invoice needs the taxable value and the rate. Moving the row must not lose them.
    const html = renderReceiptHtml(doc(), 'en');
    expect(html).toMatch(/9%/);
    expect(html).toMatch(/90\.76/);
  });

  it('FOOTS: everything above the total adds up to exactly the total', () => {
    /*
      The assertion the whole file exists for. Before the fix this column held ₹100 + ₹7.10 +
      ₹8.17 + ₹8.17 = ₹123.44 above a total of ₹107.10.
    */
    const rows = totalsRows(renderReceiptHtml(doc(), 'en'));
    const totalAt = rows.findIndex((r) => r.label === 'Total');
    const above = rows.slice(0, totalAt).reduce((sum, r) => sum + r.amount, 0);
    expect(above).toBe(rows[totalAt].amount);
  });
});

describe('receipt footing — tax added on top', () => {
  /** The other model, unchanged: a US-style sales tax that IS an additional charge. */
  const exclusive = doc({
    totals: {
      subtotalMinor: 10_000,
      discountMinor: 0,
      feeMinor: 404,
      taxMinor: 1_040,
      totalMinor: 11_444,
    },
    taxLines: [
      { label: 'Sales tax', rateBasisPoints: 1_000, baseMinor: 10_404, amountMinor: 1_040 },
    ],
  });

  it('still lists an exclusive tax ABOVE the total, where it is added', () => {
    const rows = totalsRows(renderReceiptHtml(exclusive, 'en'));
    const totalAt = rows.findIndex((r) => r.label === 'Total');
    const taxAt = rows.findIndex((r) => /Sales tax/.test(r.label));
    expect(taxAt).toBeLessThan(totalAt);
  });

  it('does not claim an exclusive tax is included', () => {
    const html = renderReceiptHtml(exclusive, 'en');
    expect(html).not.toMatch(/Includes Sales tax/);
  });

  it('FOOTS the other way: subtotal + fee + tax equals the total', () => {
    // Same invariant, opposite model — and the reason the fix could not simply move the rows
    // for everybody.
    const rows = totalsRows(renderReceiptHtml(exclusive, 'en'));
    const totalAt = rows.findIndex((r) => r.label === 'Total');
    const above = rows.slice(0, totalAt).reduce((sum, r) => sum + r.amount, 0);
    expect(above).toBe(rows[totalAt].amount);
  });
});

describe('receipt footing — no tax at all', () => {
  it('is unchanged when nothing was taxed, which is what ships by default', () => {
    const untaxed = doc({
      totals: {
        subtotalMinor: 10_000,
        discountMinor: 0,
        feeMinor: 500,
        taxMinor: 0,
        totalMinor: 10_500,
      },
      taxLines: [],
    });
    const rows = totalsRows(renderReceiptHtml(untaxed, 'en'));
    expect(rows.some((r) => /Includes/.test(r.label))).toBe(false);
    const totalAt = rows.findIndex((r) => r.label === 'Total');
    expect(rows.slice(0, totalAt).reduce((sum, r) => sum + r.amount, 0)).toBe(10_500);
  });
});
