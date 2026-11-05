import { AppException } from '../common/errors';
import { billingConfigurationErrors } from '../config/configuration';
import { BillingInvoiceService } from './billing-invoice.service';
import { invoiceDocumentFacts, renderBillingInvoiceHtml } from './billing-invoice-html';
import { BillingTaxService } from './billing-tax.service';
import {
  assertIndiaSellerReady,
  gstinCheckChar,
  gstinValid,
  indiaSellerDetails,
  indiaSellerProblems,
  sacValid,
} from './billing-seller';

/**
 * An Indian platform invoice (ETGB) is a GST tax invoice: it names the seller's GSTIN, SAC,
 * registered address and state, the buyer's state (place of supply) and GSTIN if recorded,
 * and CGST + SGST (same state) or IGST (another state) with rates. In PRODUCTION nothing
 * Indian is sold or invoiced while those seller facts are missing or the GSTIN is invalid.
 *
 * Every GSTIN, SAC and address here is a TEST value: format-valid, obviously not real.
 */
const TEST_GSTIN_TG = '36TESTA0000T1ZO'; // TEST: Telangana (36), PAN-shaped "TESTA0000T"
const TEST_GSTIN_KA = '29TESTA0000T1ZJ'; // TEST: Karnataka (29)
const TEST_SAC = '990000'; // TEST: chapter 99 shape only
const TEST_ADDRESS = 'TEST ONLY, 1 Test Street, Test Nagar, Hyderabad 500001';

const SELLER_ENV = {
  BILLING_SELLER_GST_STATUS_IN: 'REGISTERED',
  BILLING_SELLER_GSTIN_IN: TEST_GSTIN_TG,
  BILLING_SELLER_SAC_IN: TEST_SAC,
  BILLING_SELLER_ADDRESS_IN: TEST_ADDRESS,
  PLATFORM_TAX_REGION: 'Telangana',
};
const getter = (env: Record<string, string | undefined>) => (k: string) => env[k];
const configOf = (env: Record<string, string | undefined>) => ({ get: getter(env) }) as never;

describe('GSTIN and SAC checks', () => {
  it('accepts a GSTIN whose check character matches (the published sample) and TEST values', () => {
    expect(gstinValid('27AAPFU0939F1ZV')).toBe(true);
    expect(gstinValid(TEST_GSTIN_TG)).toBe(true);
    expect(gstinCheckChar('36TESTA0000T1Z')).toBe('O');
  });

  it('refuses a wrong check character, a wrong shape and nothing', () => {
    expect(gstinValid('27AAPFU0939F1ZA')).toBe(false);
    expect(gstinValid('36TESTA0000T1Z')).toBe(false);
    expect(gstinValid('36testa0000t1zo ')).toBe(true); // tolerant of case and spaces
    expect(gstinValid('3XTESTA0000T1ZO')).toBe(false);
    expect(gstinValid('')).toBe(false);
    expect(gstinValid(null)).toBe(false);
  });

  it('a SAC is six digits starting 99', () => {
    expect(sacValid(TEST_SAC)).toBe(true);
    expect(sacValid('998')).toBe(false);
    expect(sacValid('123456')).toBe(false);
  });
});

describe('India seller details', () => {
  it('reads name from the India entity and the facts from configuration', () => {
    expect(indiaSellerDetails(getter(SELLER_ENV))).toEqual({
      legalName: 'DeepTrics Software Solutions Private Limited',
      country: 'IN',
      gstStatus: 'REGISTERED',
      gstin: TEST_GSTIN_TG,
      sac: TEST_SAC,
      address: TEST_ADDRESS,
      state: 'Telangana',
      stateCode: '36',
    });
    expect(indiaSellerProblems(getter(SELLER_ENV))).toEqual([]);
  });

  it('names every missing fact, by variable name only', () => {
    const problems = indiaSellerProblems(getter({ BILLING_SELLER_GST_STATUS_IN: 'REGISTERED' }));
    expect(problems.join('\n')).toMatch(/BILLING_SELLER_GSTIN_IN is not set/);
    expect(problems.join('\n')).toMatch(/BILLING_SELLER_SAC_IN is not set/);
    expect(problems.join('\n')).toMatch(/BILLING_SELLER_ADDRESS_IN is not set/);
    expect(problems.join('\n')).toMatch(/PLATFORM_TAX_REGION is not set/);
  });

  it('refuses an invalid GSTIN and one registered in another state', () => {
    expect(
      indiaSellerProblems(getter({ ...SELLER_ENV, BILLING_SELLER_GSTIN_IN: '36TESTA0000T1ZA' })),
    ).toEqual([expect.stringMatching(/not a valid GSTIN/)]);
    expect(
      indiaSellerProblems(getter({ ...SELLER_ENV, BILLING_SELLER_GSTIN_IN: TEST_GSTIN_KA })),
    ).toEqual([expect.stringMatching(/another state than PLATFORM_TAX_REGION/)]);
  });

  it('PRODUCTION refuses India when the facts are missing or invalid; elsewhere it passes', () => {
    const prod = { APP_ENV: 'PRODUCTION', BILLING_SELLER_GST_STATUS_IN: 'REGISTERED' };
    expect(() => assertIndiaSellerReady(getter(prod), 'IN')).toThrow(AppException);
    expect(() =>
      assertIndiaSellerReady(
        getter({ ...prod, ...SELLER_ENV, BILLING_SELLER_GSTIN_IN: '36TESTA0000T1ZA' }),
        'IN',
      ),
    ).toThrow(/cannot issue a GST tax invoice/);
    expect(() => assertIndiaSellerReady(getter({ ...prod, ...SELLER_ENV }), 'IN')).not.toThrow();
    expect(() => assertIndiaSellerReady(getter(prod), 'US')).not.toThrow();
    expect(() => assertIndiaSellerReady(getter({ APP_ENV: 'QA' }), 'IN')).not.toThrow();
  });

  it('the boot refuses live India billing without the seller facts', () => {
    const base = {
      APP_ENV: 'PRODUCTION',
      BILLING_ENABLED: 'true',
      BILLING_PROVIDER: 'providers',
      BILLING_LIVE_ENABLED: 'true',
      BILLING_LIVE_MARKETS: 'IN',
      BILLING_SELLER_GST_STATUS_IN: 'REGISTERED',
      RAZORPAY_BILLING_KEY_ID: 'rzp_live_KEYID',
      RAZORPAY_BILLING_KEY_SECRET: 'rzpsecretVALUE',
      RAZORPAY_BILLING_WEBHOOK_SECRET: 'rzpwebhookVALUE',
    };
    const out = billingConfigurationErrors(base).join('\n');
    expect(out).toMatch(/BILLING_SELLER_GSTIN_IN is not set/);
    expect(out).toMatch(/BILLING_SELLER_SAC_IN is not set/);
    expect(out).toMatch(/BILLING_SELLER_ADDRESS_IN is not set/);
    expect(out).toMatch(/PLATFORM_TAX_REGION is not set/);
    expect(
      billingConfigurationErrors({
        ...base,
        ...SELLER_ENV,
        BILLING_SELLER_GSTIN_IN: '36TESTA0000T1ZA',
      }).join('\n'),
    ).toMatch(/not a valid GSTIN/);
    expect(billingConfigurationErrors({ ...base, ...SELLER_ENV })).toEqual([]);
    // US-only live billing is not held up by India's invoice facts.
    expect(
      billingConfigurationErrors({
        ...base,
        BILLING_LIVE_MARKETS: 'US',
        STRIPE_BILLING_SECRET_KEY: 'sk_live_x',
        STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_x',
      }).join('\n'),
    ).not.toMatch(/BILLING_SELLER/);
  });
});

// ── The tax on a plan: same state CGST + SGST, another state IGST ─────────────────

function taxService(orgRegion: string | null, env: Record<string, string> = SELLER_ENV) {
  const rule = {
    id: 'tr_1',
    label: 'GST',
    rateBasisPoints: 1800,
    appliesTo: 'PLATFORM_SERVICES',
    country: 'IN',
    region: null,
    currency: 'INR',
    priority: 100,
    active: true,
    effectiveFrom: null,
    effectiveTo: null,
    taxGroup: null,
    category: null,
    minUnitMinor: null,
    maxUnitMinor: null,
    inclusive: false,
    split: 'CGST_SGST',
  };
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue({ registeredRegion: orgRegion }) },
    taxRule: { findMany: jest.fn().mockResolvedValue([rule]) },
  };
  return new BillingTaxService(prisma as never, configOf(env));
}

describe('GST on an Indian plan (rates come from the rule, never from code)', () => {
  const quote = (region: string) =>
    taxService(region).quote({
      organizationId: 'org-1',
      country: 'IN',
      currency: 'INR',
      amountMinor: 99900,
    });

  it('an organizer in the seller state pays CGST + SGST, half the rate each', async () => {
    const q = await quote('Telangana');
    expect(q.lines.map((l) => [l.label, l.rateBasisPoints, l.amountMinor])).toEqual([
      ['CGST', 900, 8991],
      ['SGST', 900, 8991],
    ]);
    expect(q.totalMinor).toBe(117882);
    expect(q.jurisdiction.interState).toBe(false);
  });

  it('an organizer in another state pays IGST at the full rate', async () => {
    const q = await quote('Karnataka');
    expect(q.lines.map((l) => [l.label, l.rateBasisPoints, l.amountMinor])).toEqual([
      ['IGST', 1800, 17982],
    ]);
    expect(q.totalMinor).toBe(117882);
    expect(q.jurisdiction.interState).toBe(true);
  });
});

// ── The invoice: facts frozen at issue ────────────────────────────────────────────

function tx(opts: { buyerRegion?: string | null; taxId?: string | null } = {}) {
  const create = jest.fn().mockImplementation(({ data }) => data);
  const counter = jest.fn().mockResolvedValue([{ value: 1 }]);
  return {
    create,
    counter,
    tx: {
      organizerInvoice: { findUnique: jest.fn().mockResolvedValue(null), create },
      organizerBillingAccount: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'acc',
          organizationId: 'org-1',
          country: 'IN',
          taxId: opts.taxId ?? null,
        }),
      },
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          name: 'Test Org',
          legalName: 'Test Org Private Limited',
          registeredRegion: opts.buyerRegion ?? 'Karnataka',
        }),
      },
      $queryRaw: counter,
    },
  };
}

const PAID = {
  accountId: 'acc',
  provider: 'RAZORPAY_BILLING' as const,
  providerInvoiceRef: 'inv_TEST1',
  paymentRef: 'pay_TEST1',
  currency: 'INR',
  lines: [{ description: 'Pro plan, monthly', quantity: 1, unitAmountMinor: 99900 }],
  taxMinor: 17982,
  tax: {
    lines: [{ label: 'IGST', rateBasisPoints: 1800, baseMinor: 99900, amountMinor: 17982 }],
    mode: 'MANUAL' as const,
    jurisdiction: {
      country: 'IN',
      region: 'Karnataka',
      sellerRegion: 'Telangana',
      interState: true,
    },
  },
  paidAt: new Date('2026-11-01T10:00:00.000Z'),
};

describe('Indian platform invoice', () => {
  it('freezes the seller GSTIN, SAC, address and state, the buyer and the payment reference', async () => {
    const t = tx({ taxId: TEST_GSTIN_KA });
    const svc = new BillingInvoiceService({} as never, configOf(SELLER_ENV));
    await svc.recordPaidInTx(t.tx as never, PAID);
    const data = t.create.mock.calls[0][0].data as { number: string; documentJson: unknown };
    expect(data.number).toBe('ETGB-2627-000001');
    expect(data.number.length).toBeLessThanOrEqual(16);
    const doc = data.documentJson as Record<string, unknown>;
    expect(doc.seller).toMatchObject({
      legalName: 'DeepTrics Software Solutions Private Limited',
      country: 'IN',
      gstin: TEST_GSTIN_TG,
      sac: TEST_SAC,
      address: TEST_ADDRESS,
      state: 'Telangana',
      stateCode: '36',
    });
    expect(doc.buyer).toEqual({
      name: 'Test Org Private Limited',
      country: 'IN',
      state: 'Karnataka',
      taxId: TEST_GSTIN_KA,
    });
    expect(doc.paymentRef).toBe('pay_TEST1');
  });

  it('a later configuration change never rewrites an issued invoice', async () => {
    const t = tx();
    const env: Record<string, string | undefined> = { ...SELLER_ENV };
    await new BillingInvoiceService({} as never, configOf(env)).recordPaidInTx(t.tx as never, PAID);
    const stored = JSON.parse(JSON.stringify(t.create.mock.calls[0][0].data.documentJson));
    // The registered address changes after issue: the stored document is what renders.
    env.BILLING_SELLER_ADDRESS_IN = 'TEST ONLY, 2 Other Street, Hyderabad 500002';
    const facts = invoiceDocumentFacts(stored);
    expect(facts.seller?.address).toBe(TEST_ADDRESS);
    expect(facts.seller?.gstin).toBe(TEST_GSTIN_TG);
  });

  it('PRODUCTION refuses an Indian invoice without valid seller facts, before taking a number', async () => {
    const t = tx();
    const svc = new BillingInvoiceService(
      {} as never,
      configOf({ APP_ENV: 'PRODUCTION', ...SELLER_ENV, BILLING_SELLER_GSTIN_IN: undefined }),
    );
    await expect(svc.recordPaidInTx(t.tx as never, PAID)).rejects.toThrow(
      /cannot issue a GST tax invoice/,
    );
    expect(t.counter).not.toHaveBeenCalled();
    expect(t.create).not.toHaveBeenCalled();
  });

  it('prints a tax invoice: seller GSTIN, address, state, SAC, buyer GSTIN, IGST with its rate', () => {
    const html = renderBillingInvoiceHtml({
      number: 'ETGB-2627-000001',
      status: 'PAID',
      issuedAt: new Date('2026-11-01T10:00:00.000Z'),
      currency: 'INR',
      lines: PAID.lines,
      subtotalMinor: 99900,
      taxMinor: 17982,
      totalMinor: 117882,
      taxLines: [{ label: 'IGST', rateBasisPoints: 1800, amountMinor: 17982 }],
      placeOfSupply: 'Karnataka, IN',
      periodStart: null,
      periodEnd: null,
      sellerName: 'DeepTrics Software Solutions Private Limited',
      seller: {
        gstin: TEST_GSTIN_TG,
        sac: TEST_SAC,
        address: TEST_ADDRESS,
        state: 'Telangana',
        stateCode: '36',
      },
      paymentRef: 'pay_TEST1',
      billedTo: {
        name: 'Test Org Private Limited',
        country: 'IN',
        taxId: TEST_GSTIN_KA,
        email: null,
        state: 'Karnataka',
      },
    });
    expect(html).toContain('<h1>Tax invoice</h1>');
    expect(html).toContain(`GSTIN: ${TEST_GSTIN_TG}`);
    expect(html).toContain('State: Telangana (code 36)');
    expect(html).toContain('(SAC 990000)');
    expect(html).toContain('SAC: 990000.');
    expect(html).toContain(`Karnataka, IN - GSTIN ${TEST_GSTIN_KA}`);
    expect(html).toContain('Place of supply: Karnataka, IN.');
    expect(html).toMatch(/IGST \(18%\)<\/th><td class="num">[^<]*179\.82/);
    expect(html).toContain('Payment reference: pay_TEST1.');
  });

  it('prints CGST and SGST with their rates for a same-state organizer', () => {
    const html = renderBillingInvoiceHtml({
      number: 'ETGB-2627-000002',
      status: 'PAID',
      issuedAt: new Date('2026-11-01T10:00:00.000Z'),
      currency: 'INR',
      lines: PAID.lines,
      subtotalMinor: 99900,
      taxMinor: 17982,
      totalMinor: 117882,
      taxLines: [
        { label: 'CGST', rateBasisPoints: 900, amountMinor: 8991 },
        { label: 'SGST', rateBasisPoints: 900, amountMinor: 8991 },
      ],
      placeOfSupply: 'Telangana, IN',
      periodStart: null,
      periodEnd: null,
      sellerName: 'DeepTrics Software Solutions Private Limited',
      billedTo: { name: 'Test Org', country: 'IN', taxId: null, email: null, state: 'Telangana' },
    });
    expect(html).toContain('CGST (9%)');
    expect(html).toContain('SGST (9%)');
    expect(html).not.toContain('IGST');
    // No seller facts recorded (an older invoice): it stays a plain "Invoice".
    expect(html).toContain('<h1>Invoice</h1>');
  });

  it('an invoice issued before the facts were recorded has none', () => {
    expect(invoiceDocumentFacts({ seller: { legalName: 'X', country: 'IN' } })).toEqual({
      seller: null,
      buyer: null,
      paymentRef: null,
    });
  });
});
