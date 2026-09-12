import { ReceiptsService } from './receipts.service';

/**
 * The credit note for a refund of a discounted ticket.
 *
 * The refund service prices a returned ticket at what the customer paid for it after the
 * coupon. The credit note re-derived the ticket value from `unitPriceMinor` — the price before
 * the coupon — and used it to split the refund into ticket and tax, so a document a tax
 * authority may read stated more tax, and less ticket, than had actually gone back.
 */
function setup() {
  // Two ₹500 tickets, a 50% coupon, and a 10% tax ADDED to the discounted ₹500.
  const booking = {
    id: 'b1',
    organizationId: 'org-1',
    currency: 'INR',
    reference: 'ETG-IND-2026-000001',
    buyerName: 'Ada',
    buyerEmail: 'ada@example.test',
    subtotalMinor: 100_000,
    discountMinor: 50_000,
    taxMinor: 5_000,
    items: [{ id: 'i1', ticketTypeId: 't1', addOnId: null, unitPriceMinor: 50_000, quantity: 2 }],
    taxLines: [
      {
        label: 'Fixture tax',
        rateBasisPoints: 1_000,
        baseMinor: 50_000,
        amountMinor: 5_000,
        basis: 'TICKETS',
        inclusive: false,
      },
    ],
  };
  // One ticket back: ₹250 paid for it, plus its ₹25 of tax.
  const refund = {
    id: 'rf-1',
    amountMinor: 27_500,
    taxMinor: 2_500,
    reason: 'changed my mind',
    ticketIds: ['tk1'],
    booking,
    creditNote: null,
  };
  const create = jest.fn().mockResolvedValue({});
  const tx = {
    refund: { findUnique: jest.fn().mockResolvedValue(refund) },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        name: 'Cinema',
        legalName: null,
        taxRegistrationKind: null,
        taxRegistrationNumber: null,
        registeredAddressLine1: null,
        registeredAddressLine2: null,
        registeredCity: null,
        registeredRegion: null,
        registeredPostalCode: null,
        registeredCountry: null,
        financeContactName: null,
        financeContactEmail: null,
        financeContactPhone: null,
      }),
    },
    receipt: { findUnique: jest.fn().mockResolvedValue(null), create },
    receiptCounter: { upsert: jest.fn().mockResolvedValue({ value: 1 }) },
    ticket: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'tk1', ticketTypeId: 't1' },
        { id: 'tk2', ticketTypeId: 't1' },
      ]),
    },
  };
  return { service: new ReceiptsService({} as never), tx, create };
}

describe('ReceiptsService.issueCreditNote — a discounted ticket', () => {
  it('states the ticket at what was paid for it, and only the tax that went back', async () => {
    const { service, tx, create } = setup();
    await service.issueCreditNote(tx as never, 'rf-1');

    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      kind: 'CREDIT_NOTE',
      subtotalMinor: -25_000,
      taxMinor: -2_500,
      totalMinor: -27_500,
    });
    const taxLines = (
      data.documentJson as { taxLines: { baseMinor: number; amountMinor: number }[] }
    ).taxLines;
    expect(taxLines).toEqual([
      expect.objectContaining({ baseMinor: -25_000, amountMinor: -2_500 }),
    ]);
  });
});
