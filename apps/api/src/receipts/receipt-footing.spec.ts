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
    // By their full names, as the checkout shows them: "Central GST (CGST)".
    expect(html).toMatch(/Includes Central GST \(CGST\)/);
    expect(html).toMatch(/Includes State GST \(SGST\)/);
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

describe('receipt footing — GST inside the ticket AND added to the fee (one Indian order)', () => {
  /*
    RCT-2026-000001 from QA, exactly. One ₹499 ticket with GST inside its price, a ₹10 booking
    fee and ₹10.18 payment processing with GST ADDED to them:

        ticket  ₹499.00  = ₹422.88 taxable + ₹38.06 CGST + ₹38.06 SGST   (inside)
        fees     ₹20.18  + ₹1.82 CGST + ₹1.82 SGST                         (added)
        total   ₹522.82  = 499 + 20.18 + 3.64

    The receipt decided "inclusive or not" once for the whole document. 499 + 20.18 is not
    522.82, so it judged the document exclusive and printed all four GST rows above the total:
    a column adding to ₹598.94 under a total of ₹522.82.
  */
  const ticketGst = { rateBasisPoints: 900, baseMinor: 42_288, amountMinor: 3_806 };
  const feeGst = { rateBasisPoints: 900, baseMinor: 2_018, amountMinor: 182 };
  const mixed = (declared: boolean) =>
    doc({
      number: 'RCT-2026-000001',
      lines: [{ description: 'Gold', quantity: 1, unitPriceMinor: 49_900, lineTotalMinor: 49_900 }],
      totals: {
        subtotalMinor: 49_900,
        discountMinor: 0,
        feeMinor: 2_018,
        taxMinor: 7_976,
        totalMinor: 52_282,
      },
      feeParts: { bookingFeeMinor: 1_000, paymentFeeMinor: 1_018 },
      taxLines: [
        { label: 'CGST', ...ticketGst, ...(declared ? { basis: 'TICKETS', inclusive: true } : {}) },
        { label: 'SGST', ...ticketGst, ...(declared ? { basis: 'TICKETS', inclusive: true } : {}) },
        { label: 'CGST', ...feeGst, ...(declared ? { basis: 'FEES', inclusive: false } : {}) },
        { label: 'SGST', ...feeGst, ...(declared ? { basis: 'FEES', inclusive: false } : {}) },
      ],
    } as Partial<ReceiptDocument>);

  const split = (html: string) => {
    const rows = totalsRows(html);
    const totalAt = rows.findIndex((r) => r.label === 'Total');
    return { rows, totalAt, above: rows.slice(0, totalAt), below: rows.slice(totalAt + 1) };
  };

  it('FOOTS: ticket + booking fee + processing + GST on the fees = ₹522.82', () => {
    const { rows, totalAt, above } = split(renderReceiptHtml(mixed(true), 'en'));
    expect(rows[totalAt].amount).toBe(52_282);
    // Payment processing, then the platform fee — the order the checkout shows.
    expect(above.map((r) => r.amount)).toEqual([49_900, 1_018, 1_000, 182, 182]);
    expect(above.map((r) => r.label).slice(1, 3)).toEqual([
      'Payment processing fee',
      'Platform fee',
    ]);
    expect(above.reduce((sum, r) => sum + r.amount, 0)).toBe(52_282);
  });

  it('puts the GST on the fees above the total, saying it is on the fees', () => {
    const { above } = split(renderReceiptHtml(mixed(true), 'en'));
    const feeTax = above.filter((r) => /GST/.test(r.label));
    expect(feeTax).toHaveLength(2);
    for (const row of feeTax) expect(row.label).toMatch(/@ 9% on fees of ₹20\.18/);
  });

  it('puts the GST inside the ticket price below the total, saying so in words', () => {
    const { below } = split(renderReceiptHtml(mixed(true), 'en'));
    const ticketTax = below.filter((r) => /GST/.test(r.label));
    expect(ticketTax.map((r) => r.amount)).toEqual([3_806, 3_806]);
    for (const row of ticketTax) {
      expect(row.label).toMatch(
        /^Included in ticket price: (Central|State) GST \([CS]GST\) @ 9% on ₹422\.88$/,
      );
    }
  });

  it('states the total tax once, so nobody has to add four rows on two sides of the total', () => {
    const { below } = split(renderReceiptHtml(mixed(true), 'en'));
    expect(below.at(-1)).toEqual({ label: 'Total tax in this order', amount: 7_976 });
  });

  it('gets a document issued BEFORE lines declared themselves right from the arithmetic', () => {
    /*
      Every receipt already issued is immutable JSON with no `inclusive` on its lines. The two
      lines whose sum closes the gap between subtotal + fee and the total are the added ones.
    */
    const legacy = split(renderReceiptHtml(mixed(false), 'en'));
    const declared = split(renderReceiptHtml(mixed(true), 'en'));
    expect(legacy.above.map((r) => r.amount)).toEqual(declared.above.map((r) => r.amount));
    expect(legacy.below.map((r) => r.amount)).toEqual(declared.below.map((r) => r.amount));
    expect(legacy.above.reduce((sum, r) => sum + r.amount, 0)).toBe(52_282);
  });

  it('reads the same way in French', () => {
    const html = renderReceiptHtml(mixed(true), 'fr-CA');
    expect(html).toMatch(/Compris dans le prix des billets : GST centrale \(CGST\)/);
    expect(html).toMatch(/sur des frais de/);
    expect(html).toMatch(/Total des taxes de cette commande/);
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
