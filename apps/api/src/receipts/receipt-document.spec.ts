import {
  buildReceiptDocument,
  negateTotals,
  resolveSaleKind,
  type BuildReceiptInput,
  type ReceiptSeller,
} from './receipt-document';
import { formatMinor, renderReceiptHtml } from './receipt-html';

const seller = (over: Partial<ReceiptSeller> = {}): ReceiptSeller => ({
  name: 'Aurora Live',
  legalName: 'Aurora Live Entertainment Pvt Ltd',
  taxRegistrationKind: null,
  taxRegistrationNumber: null,
  address: {
    line1: '12 Residency Road',
    line2: null,
    city: 'Bengaluru',
    region: 'KA',
    postalCode: '560025',
    country: 'India',
  },
  contactName: 'Finance',
  contactEmail: 'finance@aurora.test',
  contactPhone: null,
  ...over,
});

const input = (over: Partial<BuildReceiptInput> = {}): BuildReceiptInput => ({
  kind: 'RECEIPT',
  number: 'RCT-2026-000001',
  issuedAt: new Date('2026-08-23T10:00:00Z'),
  currency: 'INR',
  seller: seller(),
  buyer: { name: 'Asha Rao', email: 'asha@example.test' },
  order: {
    bookingId: 'bk-1',
    reference: 'ETG-IND-2026-000123',
    eventTitle: 'Night of Strings',
    sessionStartsAt: '2026-09-01T14:30:00Z',
    venue: 'Chowdiah Hall, Bengaluru',
  },
  lines: [
    {
      description: 'General admission',
      quantity: 2,
      unitPriceMinor: 50_000,
      lineTotalMinor: 100_000,
    },
  ],
  taxLines: [],
  totals: {
    subtotalMinor: 100_000,
    discountMinor: 0,
    feeMinor: 4_040,
    taxMinor: 0,
    totalMinor: 104_040,
  },
  ...over,
});

describe('resolveSaleKind', () => {
  it('issues a plain receipt when the seller has no tax registration', () => {
    expect(resolveSaleKind({ taxRegistrationNumber: null })).toBe('RECEIPT');
    expect(resolveSaleKind({ taxRegistrationNumber: '   ' })).toBe('RECEIPT');
  });

  it('issues a tax invoice once a registration is recorded', () => {
    expect(resolveSaleKind({ taxRegistrationNumber: '29AABCU9603R1ZM' })).toBe('TAX_INVOICE');
  });
});

describe('buildReceiptDocument', () => {
  it('states plainly that no tax was charged, rather than silently omitting it', () => {
    // An absent tax row is ambiguous — zero-rated, exempt, or misconfigured all look the
    // same. Saying so makes the platform's actual behaviour legible.
    const doc = buildReceiptDocument(input());
    expect(doc.notes).toContain('No tax was charged on this sale.');
  });

  it('says why a document is not a tax invoice when the seller is unregistered', () => {
    const doc = buildReceiptDocument(input());
    expect(doc.notes).toContain(
      'The seller has not recorded a tax registration, so this is not a tax invoice.',
    );
  });

  it('drops both disclaimers once the seller is registered and tax is charged', () => {
    const doc = buildReceiptDocument(
      input({
        kind: 'TAX_INVOICE',
        seller: seller({ taxRegistrationKind: 'GSTIN', taxRegistrationNumber: '29AABCU9603R1ZM' }),
        taxLines: [
          { label: 'Test tax', rateBasisPoints: 1_000, baseMinor: 100_000, amountMinor: 10_000 },
        ],
      }),
    );
    expect(doc.notes).toEqual([]);
  });

  it('is deterministic — the same inputs produce identical bytes', () => {
    expect(JSON.stringify(buildReceiptDocument(input()))).toBe(
      JSON.stringify(buildReceiptDocument(input())),
    );
  });
});

describe('negateTotals', () => {
  it('negates every money field so period sums net out without special-casing', () => {
    const t = {
      subtotalMinor: 100_000,
      discountMinor: 500,
      feeMinor: 4_040,
      taxMinor: 10_404,
      totalMinor: 114_444,
    };
    const credit = negateTotals(t);
    expect(credit.totalMinor).toBe(-114_444);
    // The property that matters: a sale plus its full reversal is zero in every column.
    for (const k of Object.keys(t) as (keyof typeof t)[]) {
      expect(t[k] + credit[k]).toBe(0);
    }
  });
});

describe('formatMinor', () => {
  it('respects the currency’s own decimal places rather than assuming two', () => {
    // JPY has none. A hand-rolled /100 would print "¥1,040.40" for 104040 minor units,
    // which is wrong by two orders of magnitude.
    expect(formatMinor(104_040, 'JPY')).toBe('¥104,040');
    expect(formatMinor(104_040, 'USD')).toBe('$1,040.40');
  });

  it('falls back visibly instead of throwing on an unknown currency code', () => {
    expect(formatMinor(1_000, 'XYZ')).toContain('XYZ');
  });
});

describe('renderReceiptHtml', () => {
  it('renders a self-contained page with no external references', () => {
    const html = renderReceiptHtml(buildReceiptDocument(input()));
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('escapes seller and buyer text so a crafted name cannot inject markup', () => {
    const html = renderReceiptHtml(
      buildReceiptDocument(
        input({ buyer: { name: '<img src=x onerror=alert(1)>', email: 'a@b.test' } }),
      ),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('shows every tax line with its rate and base, so the arithmetic is checkable', () => {
    const html = renderReceiptHtml(
      buildReceiptDocument(
        input({
          taxLines: [
            { label: 'Federal', rateBasisPoints: 500, baseMinor: 100_000, amountMinor: 5_000 },
            { label: 'Provincial', rateBasisPoints: 700, baseMinor: 100_000, amountMinor: 7_000 },
          ],
        }),
      ),
    );
    expect(html).toContain('Federal @ 5% on');
    expect(html).toContain('Provincial @ 7% on');
  });

  it('names a credit note as such and points at what it reverses', () => {
    const html = renderReceiptHtml(
      buildReceiptDocument(
        input({
          kind: 'CREDIT_NOTE',
          number: 'CRN-2026-000001',
          totals: negateTotals(input().totals),
          reverses: { number: 'RCT-2026-000001', issuedAt: new Date('2026-08-23T10:00:00Z') },
          reason: 'Event cancelled',
        }),
      ),
    );
    expect(html).toContain('Credit note');
    expect(html).toContain('RCT-2026-000001');
    expect(html).toContain('Total refunded');
    expect(html).toContain('Event cancelled');
  });
});
