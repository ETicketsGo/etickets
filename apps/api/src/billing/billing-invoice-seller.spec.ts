import { BillingInvoiceService } from './billing-invoice.service';
import {
  LEGACY_INVOICE_SELLER,
  invoiceSellerName,
  renderBillingInvoiceHtml,
} from './billing-invoice-html';

/**
 * The company a platform invoice to an organizer names as its seller.
 *
 * Resolved from the billing account's country - the same country the number series follows,
 * so an ETGB (India) number is always issued by the Indian company and an ETG-BIL-US one by
 * DeepTrics LLC - and frozen on the document. An invoice issued before the seller was
 * recorded keeps printing "ETicketsGo", which is what it printed then.
 */

function txFor(country: string) {
  const create = jest.fn().mockImplementation(({ data }) => data);
  const tx = {
    organizerInvoice: { findUnique: jest.fn().mockResolvedValue(null), create },
    organizerBillingAccount: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'acc', organizationId: 'org-1', country, taxId: null }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ value: 1 }]),
  };
  return { tx, create };
}

async function paid(country: string, currency: string) {
  const { tx, create } = txFor(country);
  const svc = new BillingInvoiceService({} as never);
  await svc.recordPaidInTx(tx as never, {
    accountId: 'acc',
    provider: 'MOCK',
    providerInvoiceRef: 'ref-1',
    currency,
    lines: [{ description: 'Plan', quantity: 1, unitAmountMinor: 1000 }],
    taxMinor: 0,
    paidAt: new Date('2026-10-27T10:00:00.000Z'),
  });
  return create.mock.calls[0][0].data as { number: string; documentJson: unknown };
}

describe('platform invoice seller', () => {
  it('an Indian account (ETGB series) is invoiced by the Indian company', async () => {
    const data = await paid('IN', 'INR');
    expect(data.number).toMatch(/^ETGB-/);
    expect(invoiceSellerName(data.documentJson)).toBe(
      'DeepTrics Software Solutions Private Limited',
    );
  });

  it('a US account (ETG-BIL-US series) is invoiced by DeepTrics LLC', async () => {
    const data = await paid('US', 'USD');
    expect(data.number).toMatch(/^ETG-BIL-US-/);
    expect(invoiceSellerName(data.documentJson)).toBe('DeepTrics LLC');
  });

  it('follows the account country, the series country, over the currency', async () => {
    const data = await paid('IN', 'USD');
    expect(data.number).toMatch(/^ETGB-/);
    expect(invoiceSellerName(data.documentJson)).toBe(
      'DeepTrics Software Solutions Private Limited',
    );
  });

  it('an invoice issued before the seller was recorded prints what it printed then', () => {
    const old = { number: 'ETGB-2627-000001', billingCountry: 'IN', currency: 'INR' };
    expect(invoiceSellerName(old)).toBe(LEGACY_INVOICE_SELLER);
    expect(invoiceSellerName(null)).toBe('ETicketsGo');
    expect(invoiceSellerName({ seller: { legalName: '  ' } })).toBe('ETicketsGo');
  });

  it('prints the stored seller on the invoice page', () => {
    const html = renderBillingInvoiceHtml({
      number: 'ETG-BIL-US-2026-000001',
      status: 'PAID',
      issuedAt: new Date('2026-10-27T10:00:00.000Z'),
      currency: 'USD',
      lines: [{ description: 'Plan', quantity: 1, unitAmountMinor: 1000 }],
      subtotalMinor: 1000,
      taxMinor: 0,
      totalMinor: 1000,
      periodStart: null,
      periodEnd: null,
      sellerName: invoiceSellerName({ seller: { legalName: 'DeepTrics LLC' } }),
      billedTo: { name: 'Org', country: 'US', taxId: null, email: null },
    });
    expect(html).toContain('<div class="seller">DeepTrics LLC</div>');
  });
});
