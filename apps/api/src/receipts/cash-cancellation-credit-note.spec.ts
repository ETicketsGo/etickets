import { ReceiptsService } from './receipts.service';
import { renderReceiptHtml, resolveInclusiveLines } from './receipt-html';
import type { ReceiptDocument } from './receipt-document';

/**
 * The credit note that reverses a counter cash sale whose show was cancelled (F1).
 *
 * A cash sale is reversed with no Refund row, so the credit note is keyed to the booking. It
 * must say exactly the opposite of the sale document AS ISSUED - every tax line, the fee, the
 * total - so the pair nets to zero on every column a report reads, and it must still foot as
 * a document of its own. Issued once: a second call returns the one already there.
 */

// Two INR 500 tickets, a 100 coupon, GST inside the tickets (CGST + SGST), IGST added to the fee.
const SALE_DOC: Partial<ReceiptDocument> = {
  kind: 'TAX_INVOICE',
  number: 'INV-2026-000007',
  order: {
    bookingId: 'b1',
    reference: 'ETG-IND-2026-000099',
    eventTitle: 'Walk Show',
    sessionStartsAt: '2026-10-20T13:30:00.000Z',
    venue: 'Hall, Bengaluru',
  },
  taxLines: [
    {
      label: 'CGST',
      rateBasisPoints: 900,
      baseMinor: 76_271,
      amountMinor: 6_864,
      basis: 'TICKETS',
      inclusive: true,
    },
    {
      label: 'SGST',
      rateBasisPoints: 900,
      baseMinor: 76_271,
      amountMinor: 6_865,
      basis: 'TICKETS',
      inclusive: true,
    },
    {
      label: 'IGST',
      rateBasisPoints: 1800,
      baseMinor: 3_000,
      amountMinor: 540,
      basis: 'FEES',
      inclusive: false,
    },
  ],
  feeParts: { bookingFeeMinor: 2_000, paymentFeeMinor: 1_000 },
};
const SALE = {
  id: 'rc-sale',
  number: 'INV-2026-000007',
  kind: 'TAX_INVOICE',
  organizationId: 'org-1',
  bookingId: 'b1',
  saleForBookingId: 'b1',
  issuedAt: new Date('2026-10-16T10:00:00.000Z'),
  currency: 'INR',
  subtotalMinor: 100_000,
  discountMinor: 10_000,
  feeMinor: 3_000,
  taxMinor: 14_269,
  // 100,000 - 10,000 + 3,000 + 540 (the only ADDED tax).
  totalMinor: 93_540,
  documentJson: SALE_DOC,
};

const ORG = {
  name: 'Bengaluru Live',
  legalName: 'Bengaluru Live Pvt Ltd',
  taxRegistrationKind: 'GSTIN',
  taxRegistrationNumber: '29ABCDE1234F1Z5',
  registeredAddressLine1: null,
  registeredAddressLine2: null,
  registeredCity: null,
  registeredRegion: null,
  registeredPostalCode: null,
  registeredCountry: null,
  financeContactName: null,
  financeContactEmail: null,
  financeContactPhone: null,
};

function setup(existing: { id: string; number: string } | null = null) {
  const create = jest
    .fn()
    .mockImplementation(({ data }) => ({ id: 'rc-crn', number: data.number }));
  const findUnique = jest.fn().mockImplementation(({ where }) => {
    if (where.saleForBookingId) return SALE;
    if (where.cancellationForBookingId) return existing;
    return null;
  });
  const tx = {
    receipt: { findUnique, create },
    receiptCounter: { upsert: jest.fn().mockResolvedValue({ value: 3 }) },
    booking: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'b1',
        organizationId: 'org-1',
        reference: 'ETG-IND-2026-000099',
        buyerName: 'Walk Counter Buyer',
        buyerEmail: 'box-office@example.test',
      }),
    },
    organization: { findUnique: jest.fn().mockResolvedValue(ORG) },
    // Present so a stray call to anything money-moving would be visible, never configured.
    refund: { create: jest.fn(), findUnique: jest.fn() },
    payment: { create: jest.fn(), update: jest.fn() },
  };
  return { tx, create };
}

describe('ReceiptsService.issueCancellationCreditNote (cash sale on a cancelled show)', () => {
  const svc = new ReceiptsService({} as never);

  it('issues one CRN credit note, linked to the sale receipt and the booking, with no refund', async () => {
    const { tx, create } = setup();
    const out = await svc.issueCancellationCreditNote(tx as never, 'b1', 'Show cancelled.');

    expect(out).toEqual({
      id: 'rc-crn',
      number: 'CRN-2026-000003',
      reversesId: 'rc-sale',
      reversesNumber: 'INV-2026-000007',
    });
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data.kind).toBe('CREDIT_NOTE');
    expect(data.number).toMatch(/^CRN-\d{4}-\d{6}$/);
    expect(data.bookingId).toBe('b1');
    expect(data.cancellationForBookingId).toBe('b1');
    expect(data.reversesId).toBe('rc-sale');
    expect(data.refundId).toBeUndefined();
    expect(data.saleForBookingId).toBeUndefined();
    // The CRN series is the one refund credit notes use.
    expect(tx.receiptCounter.upsert.mock.calls[0][0].where.scope).toMatch(/^org-1:CRN:\d{4}$/);
    expect(tx.refund.create).not.toHaveBeenCalled();
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it('negates the sale: total, fee and tax net to zero, and every tax line is reversed', async () => {
    const { tx, create } = setup();
    await svc.issueCancellationCreditNote(tx as never, 'b1', 'Show cancelled.');
    const data = create.mock.calls[0][0].data;

    expect(SALE.totalMinor + data.totalMinor).toBe(0);
    expect(SALE.taxMinor + data.taxMinor).toBe(0);
    expect(SALE.feeMinor + data.feeMinor).toBe(0);
    // Net revenue (subtotal less discount) nets to zero too; the credit note carries it net.
    expect(
      SALE.subtotalMinor - SALE.discountMinor + (data.subtotalMinor - data.discountMinor),
    ).toBe(0);

    const doc = data.documentJson as ReceiptDocument;
    expect(doc.reverses).toEqual({
      number: 'INV-2026-000007',
      issuedAt: '2026-10-16T10:00:00.000Z',
    });
    const byLabel = (lines: ReceiptDocument['taxLines']) =>
      Object.fromEntries(lines.map((l) => [`${l.label}|${l.rateBasisPoints}`, l.amountMinor]));
    const sale = byLabel(SALE_DOC.taxLines!);
    const crn = byLabel(doc.taxLines);
    for (const key of Object.keys(sale)) expect(sale[key] + crn[key]).toBe(0);
    expect(doc.taxLines.map((l) => [l.basis, l.inclusive])).toEqual(
      SALE_DOC.taxLines!.map((l) => [l.basis, l.inclusive]),
    );
    expect(doc.feeParts).toEqual({ bookingFeeMinor: -2_000, paymentFeeMinor: -1_000 });
    expect(doc.reason).toBe('Show cancelled.');
  });

  it('foots as a document of its own', async () => {
    const { tx, create } = setup();
    await svc.issueCancellationCreditNote(tx as never, 'b1', 'Show cancelled.');
    const doc = create.mock.calls[0][0].data.documentJson as ReceiptDocument;
    const inclusive = resolveInclusiveLines(doc);
    const added = doc.taxLines.reduce((s, l, i) => (inclusive[i] ? s : s + l.amountMinor), 0);
    expect(
      doc.totals.subtotalMinor - Math.abs(doc.totals.discountMinor) + doc.totals.feeMinor + added,
    ).toBe(doc.totals.totalMinor);
    expect(doc.lines.reduce((s, l) => s + l.lineTotalMinor, 0)).toBe(doc.totals.subtotalMinor);
    const html = renderReceiptHtml(doc, 'en');
    expect(html).toContain('INV-2026-000007');
  });

  it('is idempotent: a second call returns the credit note already issued and creates nothing', async () => {
    const { tx, create } = setup({ id: 'rc-crn', number: 'CRN-2026-000003' });
    const out = await svc.issueCancellationCreditNote(tx as never, 'b1', 'Show cancelled.');
    expect(out?.number).toBe('CRN-2026-000003');
    expect(create).not.toHaveBeenCalled();
    expect(tx.receiptCounter.upsert).not.toHaveBeenCalled();
  });

  it('issues nothing for a booking that never had a sale document', async () => {
    const { tx, create } = setup();
    tx.receipt.findUnique.mockResolvedValue(null);
    expect(await svc.issueCancellationCreditNote(tx as never, 'b1', 'x')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
