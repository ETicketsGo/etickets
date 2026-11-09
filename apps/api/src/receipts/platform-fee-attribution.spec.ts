import { ReceiptsService } from './receipts.service';
import { renderReceiptHtml } from './receipt-html';
import type { ReceiptDocument } from './receipt-document';
import { refundTaxForTickets, ticketNetPrices } from '../refunds/refund-tax';

/**
 * AR-57 (a) and (b): the platform fee and its tax belong to the platform, and a cancellation
 * credit note books the returned fee as fee, not as ticket value.
 *
 * (a) The sale document named the ORGANIZER as seller and listed the GST on the platform fee
 *     (`basis: 'FEES'`) among the organizer's tax lines. That fee is the platform's supply.
 * (b) A cancellation refund returns the fee (`platformFeeRefundedMinor`), but the credit note
 *     wrote `feeMinor: 0` and folded the fee into the subtotal and the ticket line.
 *
 * And the hard constraint: with tax OFF (production today) every document a buyer gets is
 * exactly what it was before. Money columns never move; only the attribution does.
 */

const ORG = {
  name: 'Hyderabad Live',
  legalName: 'Hyderabad Live Pvt Ltd',
  taxRegistrationKind: 'GSTIN',
  taxRegistrationNumber: '36ABCDE1234F1Z5',
  registeredAddressLine1: null,
  registeredAddressLine2: null,
  registeredCity: null,
  registeredRegion: null,
  registeredPostalCode: null,
  registeredCountry: 'IN',
  financeContactName: null,
  financeContactEmail: null,
  financeContactPhone: null,
};

// One INR 499 ticket, a 35.27 platform fee (20.00 booking + 15.27 payment).
const FEE = 3_527;
const GST_LINES = [
  // 49,900 at 18% inclusive: taxable 42,288, levy 7,612 -> 3,806 + 3,806.
  {
    label: 'CGST',
    rateBasisPoints: 900,
    baseMinor: 42_288,
    amountMinor: 3_806,
    basis: 'TICKETS',
    inclusive: true,
  },
  {
    label: 'SGST',
    rateBasisPoints: 900,
    baseMinor: 42_288,
    amountMinor: 3_806,
    basis: 'TICKETS',
    inclusive: true,
  },
  // IGST 18% ADDED to the fee: 635.
  {
    label: 'IGST',
    rateBasisPoints: 1800,
    baseMinor: FEE,
    amountMinor: 635,
    basis: 'FEES',
    inclusive: false,
  },
];

function bookingWith(taxLines: typeof GST_LINES) {
  const taxMinor = taxLines.reduce((s, l) => s + l.amountMinor, 0);
  const taxAdded = taxLines.filter((l) => !l.inclusive).reduce((s, l) => s + l.amountMinor, 0);
  return {
    id: 'b1',
    organizationId: 'org-1',
    currency: 'INR',
    reference: 'ETG-IND-2026-000057',
    buyerName: 'Ada',
    buyerEmail: 'ada@example.test',
    subtotalMinor: 49_900,
    discountMinor: 0,
    customerFeeMinor: FEE,
    bookingFeeMinor: 2_000,
    paymentFeeMinor: 1_527,
    taxMinor,
    totalMinor: 49_900 + FEE + taxAdded,
    taxLines,
    items: [
      {
        id: 'i1',
        ticketTypeId: 't1',
        addOnId: null,
        unitPriceMinor: 49_900,
        quantity: 1,
        lineTotalMinor: 49_900,
        ticketType: { name: 'General' },
        addOn: null,
      },
    ],
    event: { title: 'CMDY', venue: { name: 'Hall', city: 'Hyderabad', country: 'IN' } },
    eventSession: { startsAt: new Date('2026-12-01T13:30:00.000Z') },
  };
}

const TICKETS = [{ id: 'tk1', ticketTypeId: 't1' }];

function txFor(booking: ReturnType<typeof bookingWith>, refund?: Record<string, unknown>) {
  const create = jest.fn().mockResolvedValue({ id: 'rc-new', number: 'CRN-2026-000001' });
  const tx = {
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    refund: {
      findUnique: jest
        .fn()
        .mockResolvedValue(refund ? { ...refund, booking, creditNote: null } : null),
    },
    organization: { findUnique: jest.fn().mockResolvedValue(ORG) },
    receipt: { findUnique: jest.fn().mockResolvedValue(null), create },
    receiptCounter: { upsert: jest.fn().mockResolvedValue({ value: 1 }) },
    ticket: { findMany: jest.fn().mockResolvedValue(TICKETS) },
  };
  return { tx, create };
}

async function saleDocument(booking: ReturnType<typeof bookingWith>) {
  const { tx, create } = txFor(booking);
  await new ReceiptsService({} as never).issueForBooking(tx as never, booking.id);
  return create.mock.calls[0][0].data as {
    subtotalMinor: number;
    feeMinor: number;
    taxMinor: number;
    totalMinor: number;
    documentJson: ReceiptDocument;
  };
}

/** A refund row exactly as the refund service writes it (see refunds.service.ts). */
function refundFor(booking: ReturnType<typeof bookingWith>, cancellation: boolean) {
  const { netByTicket, bookingTicketsMinor } = ticketNetPrices(booking.items, TICKETS, booking);
  const tax = refundTaxForTickets(booking.taxLines, netByTicket, ['tk1'], bookingTicketsMinor, {
    includeFeeTax: cancellation,
  });
  const ticketsMinor = netByTicket.get('tk1')!;
  const amountMinor = cancellation ? booking.totalMinor : ticketsMinor + tax.addedMinor;
  return {
    id: cancellation ? 'r-cancel' : 'r-buyer',
    amountMinor,
    taxMinor: tax.taxMinor,
    taxAddedMinor: tax.addedMinor,
    platformFeeRefundedMinor: cancellation
      ? Math.max(0, amountMinor - tax.addedMinor - ticketsMinor)
      : 0,
    reason: cancellation ? 'Show cancelled' : 'changed my mind',
    ticketIds: ['tk1'],
  };
}

async function creditNote(booking: ReturnType<typeof bookingWith>, cancellation: boolean) {
  const refund = refundFor(booking, cancellation);
  const { tx, create } = txFor(booking, refund);
  await new ReceiptsService({} as never).issueCreditNote(tx as never, refund.id);
  return {
    refund,
    row: create.mock.calls[0][0].data as {
      subtotalMinor: number;
      feeMinor: number;
      taxMinor: number;
      totalMinor: number;
      documentJson: ReceiptDocument;
    },
  };
}

/** The organizer's totals block as label/amount rows (the first tfoot on the page). */
const footRows = (html: string, from = 0) => {
  const start = html.indexOf('<tfoot>', from);
  const foot = html.slice(start, html.indexOf('</tfoot>', start));
  return [
    ...foot.matchAll(/<th colspan="3">(.*?)<\/th><td class="num">(-?)₹([\d,]+(?:\.\d{2})?)<\/td>/g),
  ].map((m) => ({
    label: m[1],
    amount: (m[2] ? -1 : 1) * Math.round(Number(m[3].replace(/,/g, '')) * 100),
  }));
};

describe('AR-57 with tax OFF (production today): nothing changes', () => {
  const booking = bookingWith([]);

  it('the sale document has no platform-fee section and the same money as before', async () => {
    const sale = await saleDocument(booking);
    expect(sale.documentJson).not.toHaveProperty('platformFee');
    expect(sale).toMatchObject({
      subtotalMinor: 49_900,
      feeMinor: FEE,
      taxMinor: 0,
      totalMinor: 49_900 + FEE,
    });
    expect(sale.documentJson.taxLines).toEqual([]);
    expect(sale.documentJson.lines).toEqual([
      { description: 'General', quantity: 1, unitPriceMinor: 49_900, lineTotalMinor: 49_900 },
    ]);
    expect(sale.documentJson.feeParts).toEqual({ bookingFeeMinor: 2_000, paymentFeeMinor: 1_527 });
    expect(sale.documentJson.notes).toContain('No tax was charged on this sale.');
  });

  it('renders exactly as a document without the section always rendered', async () => {
    const sale = await saleDocument(booking);
    const html = renderReceiptHtml(sale.documentJson, 'en');
    expect(html).not.toContain('platform-fee');
    expect(footRows(html)).toEqual([
      { label: 'Subtotal', amount: 49_900 },
      { label: 'Payment processing fee', amount: 1_527 },
      { label: 'Platform fee', amount: 2_000 },
      { label: 'Total', amount: 49_900 + FEE },
    ]);
  });

  it("a buyer's own refund credit note is unchanged: whole amount on the ticket line, no fee", async () => {
    const { refund, row } = await creditNote(booking, false);
    expect(refund.amountMinor).toBe(49_900);
    expect(row).toMatchObject({
      subtotalMinor: -49_900,
      feeMinor: -0,
      taxMinor: -0,
      totalMinor: -49_900,
    });
    expect(row.documentJson.lines[0].lineTotalMinor).toBe(-49_900);
    expect(row.documentJson).not.toHaveProperty('platformFee');
  });

  it('a cancellation returns the same total, with the fee booked as fee (AR-57 b)', async () => {
    const { refund, row } = await creditNote(booking, true);
    // What the buyer gets back is untouched: everything they paid.
    expect(refund.amountMinor).toBe(booking.totalMinor);
    expect(row.totalMinor).toBe(-booking.totalMinor);
    // Ticket value is the ticket; the fee is the fee.
    expect(row.feeMinor).toBe(-refund.platformFeeRefundedMinor);
    expect(row.feeMinor).toBe(-FEE);
    expect(row.subtotalMinor).toBe(-49_900);
    expect(row.documentJson.lines[0].lineTotalMinor).toBe(-49_900);
    // And the document foots: subtotal + fee + added tax = total.
    expect(row.subtotalMinor + row.feeMinor - 0).toBe(row.totalMinor);
    expect(row.documentJson).not.toHaveProperty('platformFee');
  });
});

describe('AR-57 (a) with GST on: the fee GST is the platform’s, not the organizer’s', () => {
  const booking = bookingWith(GST_LINES);

  it('puts the fee and its tax in a platform-fee section naming the platform as seller', async () => {
    const sale = await saleDocument(booking);
    const pf = sale.documentJson.platformFee!;
    expect(pf).toBeDefined();
    expect(pf.seller.legalName).toBe(sale.documentJson.operator!.legalName);
    expect(pf.seller.legalName).not.toBe(ORG.legalName);
    expect(pf.seller.country).toBe('IN');
    expect(pf.feeMinor).toBe(FEE);
    expect(pf.taxLines.map((l) => l.label)).toEqual(['IGST']);
    expect(pf.totalMinor).toBe(FEE + 635);
    // The order's money is unchanged: the section is attribution, not new money.
    expect(sale.totalMinor).toBe(49_900 + FEE + 635);
    expect(sale.taxMinor).toBe(3_806 + 3_806 + 635);
    expect(sale.documentJson.taxLines).toHaveLength(3);
  });

  it("does not print the fee GST among the organizer's rows, and the organizer's column still foots", async () => {
    const sale = await saleDocument(booking);
    const html = renderReceiptHtml(sale.documentJson, 'en');
    const organizer = footRows(html);
    expect(organizer.some((r) => /IGST/.test(r.label))).toBe(false);
    const totalAt = organizer.findIndex((r) => r.label === 'Total');
    const aboveTotal = organizer.slice(0, totalAt).reduce((s, r) => s + r.amount, 0);
    expect(aboveTotal).toBe(organizer[totalAt].amount);
    expect(organizer[totalAt].amount).toBe(sale.totalMinor);
    // The ticket GST stays the organizer's, disclosed as inside the price.
    expect(organizer.some((r) => /Central GST/.test(r.label))).toBe(true);
  });

  it('itemises the fee and its tax under the platform, footing to the section total', async () => {
    const sale = await saleDocument(booking);
    const html = renderReceiptHtml(sale.documentJson, 'en');
    const at = html.indexOf('class="platform-fee"');
    expect(at).toBeGreaterThan(0);
    expect(html.slice(at)).toContain(
      `Platform fee charged by ${sale.documentJson.platformFee!.seller.legalName}`,
    );
    const rows = footRows(html, at);
    expect(rows.map((r) => r.amount)).toEqual([1_527, 2_000, 635, FEE + 635]);
    expect(rows.some((r) => /IGST/.test(r.label))).toBe(true);
  });
});

describe('AR-57 (b) with GST on: the cancellation credit note', () => {
  const booking = bookingWith(GST_LINES);

  it('books the returned fee as -platformFeeRefundedMinor and keeps it off the ticket line', async () => {
    const { refund, row } = await creditNote(booking, true);
    expect(refund.platformFeeRefundedMinor).toBe(FEE);
    expect(row.feeMinor).toBe(-FEE);
    expect(row.subtotalMinor).toBe(-49_900);
    expect(row.documentJson.lines[0].lineTotalMinor).toBe(-49_900);
    expect(row.totalMinor).toBe(-booking.totalMinor);
    // subtotal + fee + ADDED tax (the fee IGST) = total.
    expect(row.subtotalMinor + row.feeMinor - 635).toBe(row.totalMinor);
    // The fee's reversal is attributed to the platform, mirroring the sale.
    const pf = row.documentJson.platformFee!;
    expect(pf.feeMinor).toBe(-FEE);
    expect(pf.taxLines.map((l) => [l.label, l.amountMinor])).toEqual([['IGST', -635]]);
    expect(pf.totalMinor).toBe(-(FEE + 635));
  });

  it("a buyer's own refund still returns no fee and has no platform-fee section", async () => {
    const { row } = await creditNote(booking, false);
    expect(row.feeMinor).toBe(-0);
    expect(row.documentJson).not.toHaveProperty('platformFee');
  });
});
