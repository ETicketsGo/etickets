import { ReceiptsService } from './receipts.service';
import { renderReceiptHtml } from './receipt-html';
import { buildReceiptDocument, type ReceiptDocument } from './receipt-document';

/**
 * Which DeepTrics company a receipt names (the platform operator line in its footer).
 *
 * A NEW document resolves it once, at issue, from the sale itself: the venue's country, then
 * the booking currency (INR the Indian company, USD DeepTrics LLC). It is frozen on the
 * document. A document issued BEFORE this existed has no operator and must render exactly
 * as it always did: issued documents are never rewritten.
 */

const INDIA_LINE =
  'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited.';
const US_LINE = 'ETicketsGo is operated in the United States by DeepTrics LLC.';

const ORG = {
  name: 'Hall Live',
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
  financeContactEmail: 'finance@hall.test',
  financeContactPhone: null,
};

function booking(currency: string, country: string | null) {
  return {
    id: 'b1',
    organizationId: 'org-1',
    reference: 'ETG-IND-2026-000001',
    currency,
    buyerName: 'Buyer',
    buyerEmail: 'buyer@example.test',
    subtotalMinor: 50_000,
    discountMinor: 0,
    customerFeeMinor: 0,
    bookingFeeMinor: 0,
    paymentFeeMinor: 0,
    taxMinor: 0,
    totalMinor: 50_000,
    taxLines: [],
    items: [
      {
        quantity: 1,
        unitPriceMinor: 50_000,
        lineTotalMinor: 50_000,
        ticketType: { name: 'Seat' },
        addOn: null,
      },
    ],
    event: { title: 'Show', venue: { name: 'Hall', city: 'City', country } },
    eventSession: { startsAt: new Date('2026-11-01T13:30:00.000Z') },
  };
}

function txFor(b: ReturnType<typeof booking>) {
  const create = jest.fn().mockResolvedValue({});
  const tx = {
    booking: { findUnique: jest.fn().mockResolvedValue(b) },
    organization: { findUnique: jest.fn().mockResolvedValue(ORG) },
    receiptCounter: { upsert: jest.fn().mockResolvedValue({ value: 1 }) },
    receipt: { create },
  };
  return { tx, create };
}

describe('a NEW receipt names the operating company for the sale', () => {
  const svc = new ReceiptsService({} as never);

  it('an INR sale at an Indian venue names the Indian company', async () => {
    const { tx, create } = txFor(booking('INR', 'India'));
    await svc.issueForBooking(tx as never, 'b1');
    const doc = create.mock.calls[0][0].data.documentJson as ReceiptDocument;
    expect(doc.operator).toEqual({
      legalName: 'DeepTrics Software Solutions Private Limited',
      country: 'IN',
      basis: 'TRANSACTION_COUNTRY',
    });
    expect(renderReceiptHtml(doc, 'en')).toContain(INDIA_LINE);
  });

  it('a USD sale names DeepTrics LLC, from the currency when the venue has no country', async () => {
    const { tx, create } = txFor(booking('USD', null));
    await svc.issueForBooking(tx as never, 'b1');
    const doc = create.mock.calls[0][0].data.documentJson as ReceiptDocument;
    expect(doc.operator).toEqual({ legalName: 'DeepTrics LLC', country: 'US', basis: 'CURRENCY' });
    const html = renderReceiptHtml(doc, 'en');
    expect(html).toContain(US_LINE);
    expect(html).not.toContain('DeepTrics Software Solutions');
  });

  it('says it in French for a French reader, with the company name untranslated', async () => {
    const { tx, create } = txFor(booking('USD', 'United States'));
    await svc.issueForBooking(tx as never, 'b1');
    const doc = create.mock.calls[0][0].data.documentJson as ReceiptDocument;
    expect(renderReceiptHtml(doc, 'fr-CA')).toContain(
      'ETicketsGo est exploité aux États-Unis par DeepTrics LLC.',
    );
  });

  it('the seller is still the organizer: the operator is a footer line, not the seller', async () => {
    const { tx, create } = txFor(booking('INR', 'India'));
    await svc.issueForBooking(tx as never, 'b1');
    const doc = create.mock.calls[0][0].data.documentJson as ReceiptDocument;
    expect(doc.seller.name).toBe('Hall Live');
  });
});

describe('a receipt issued BEFORE operators were recorded is unchanged', () => {
  // A document exactly as one was stored before this change: no `operator` key at all.
  const STORED: ReceiptDocument = buildReceiptDocument({
    kind: 'RECEIPT',
    number: 'RCT-2026-000001',
    issuedAt: new Date('2026-10-01T10:00:00.000Z'),
    currency: 'INR',
    seller: {
      name: 'Hall Live',
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
      contactName: null,
      contactEmail: 'finance@hall.test',
      contactPhone: null,
    },
    buyer: { name: 'Buyer', email: 'buyer@example.test' },
    order: {
      bookingId: 'b0',
      reference: 'ETG-IND-2026-000000',
      eventTitle: 'Old show',
      sessionStartsAt: null,
      venue: null,
    },
    lines: [{ description: 'Seat', quantity: 1, unitPriceMinor: 500, lineTotalMinor: 500 }],
    taxLines: [],
    totals: { subtotalMinor: 500, discountMinor: 0, feeMinor: 0, taxMinor: 0, totalMinor: 500 },
  });

  it('carries no operator, and the builder adds none', () => {
    expect('operator' in STORED).toBe(false);
  });

  it('renders no operator line, and no company name it was not issued with', () => {
    const html = renderReceiptHtml(STORED, 'en');
    expect(html).not.toMatch(/operated in/);
    expect(html).not.toContain('DeepTrics');
    expect(html).toContain('Questions about this document: finance@hall.test');
  });

  it('a stored operator is printed as stored, whatever the registry says today', () => {
    const renamed = {
      ...STORED,
      operator: { legalName: 'Old Name Pvt Ltd', country: 'IN', basis: 'CURRENCY' },
    };
    expect(renderReceiptHtml(renamed as ReceiptDocument, 'en')).toContain(
      'ETicketsGo is operated in India by Old Name Pvt Ltd.',
    );
  });
});

describe('a credit note names the same company as the sale it reverses', () => {
  const svc = new ReceiptsService({} as never);

  function cancellationTx(saleDoc: Partial<ReceiptDocument>, currency = 'INR') {
    const create = jest.fn().mockImplementation(({ data }) => ({ id: 'crn', number: data.number }));
    const sale = {
      id: 'sale',
      number: 'RCT-2026-000001',
      issuedAt: new Date('2026-10-01T10:00:00.000Z'),
      currency,
      subtotalMinor: 500,
      discountMinor: 0,
      feeMinor: 0,
      taxMinor: 0,
      totalMinor: 500,
      documentJson: saleDoc,
    };
    const tx = {
      receipt: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }) => (where.saleForBookingId ? sale : null)),
        create,
      },
      receiptCounter: { upsert: jest.fn().mockResolvedValue({ value: 1 }) },
      booking: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'b1',
          organizationId: 'org-1',
          reference: 'R',
          buyerName: null,
          buyerEmail: null,
        }),
      },
      organization: { findUnique: jest.fn().mockResolvedValue(ORG) },
    };
    return { tx, create };
  }

  it('copies the sale document operator', async () => {
    const stored = { legalName: 'DeepTrics LLC', country: 'US', basis: 'CURRENCY' as const };
    const { tx, create } = cancellationTx({ operator: stored, taxLines: [] }, 'INR');
    await svc.issueCancellationCreditNote(tx as never, 'b1', 'Cancelled.');
    const doc = create.mock.calls[0][0].data.documentJson as ReceiptDocument;
    expect(doc.operator).toEqual(stored);
  });

  it('a sale issued before operators existed is left alone; the new credit note resolves its own', async () => {
    const saleDoc: Partial<ReceiptDocument> = { taxLines: [] };
    const { tx, create } = cancellationTx(saleDoc, 'INR');
    await svc.issueCancellationCreditNote(tx as never, 'b1', 'Cancelled.');
    const doc = create.mock.calls[0][0].data.documentJson as ReceiptDocument;
    expect(doc.operator?.legalName).toBe('DeepTrics Software Solutions Private Limited');
    expect(saleDoc).toEqual({ taxLines: [] });
  });
});
