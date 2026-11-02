import { AppException } from '../common/errors';
import { billingConfigurationErrors } from '../config/configuration';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingInvoiceService, TAX_NOT_APPLIED_NOTE } from './billing-invoice.service';
import { invoiceDocumentFacts, renderBillingInvoiceHtml } from './billing-invoice-html';
import { BillingTaxService } from './billing-tax.service';
import {
  GST_NOT_CHARGED_NOTE,
  assertIndiaSellerReady,
  configuredGstStatus,
  effectiveGstStatus,
  indiaSellerDetails,
  indiaSellerProblems,
} from './billing-seller';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import type { BillingProvider } from './provider/billing-provider';
import { RazorpaySubscriptionsProvider } from './provider/razorpay-subscriptions.provider';
import {
  RAZORPAY_TEST_WEBHOOK_SECRET,
  fakeRazorpay,
  razorpayState,
} from './provider/billing-provider.fixture';

/**
 * India organizer billing in both seller modes (BILLING_SELLER_GST_STATUS_IN):
 *   REGISTERED    GST tax invoice, GST added (Rs 999 -> Rs 1,178.82 at the TEST 18% rule).
 *   UNREGISTERED  no GST at all: the quote is the base price, the Razorpay plan must charge
 *                 exactly 99900, and the invoice is an ordinary "Invoice" with the note
 *                 GST_NOT_CHARGED_NOTE and no tax line, GSTIN or SAC.
 *   UNVERIFIED    refused in PRODUCTION (boot and runtime); elsewhere REGISTERED when a GSTIN
 *                 is set, else UNREGISTERED.
 *
 * The 18% rule and every GSTIN, SAC and address here is a TEST value.
 */
const TEST_GSTIN_TG = '36TESTA0000T1ZO';
const TEST_SAC = '990000';
const TEST_ADDRESS = 'TEST ONLY, 1 Test Street, Test Nagar, Hyderabad 500001';

const REGISTERED = {
  BILLING_SELLER_GST_STATUS_IN: 'REGISTERED',
  BILLING_SELLER_GSTIN_IN: TEST_GSTIN_TG,
  BILLING_SELLER_SAC_IN: TEST_SAC,
  BILLING_SELLER_ADDRESS_IN: TEST_ADDRESS,
  PLATFORM_TAX_REGION: 'Telangana',
};
const UNREGISTERED = {
  BILLING_SELLER_GST_STATUS_IN: 'UNREGISTERED',
  BILLING_SELLER_ADDRESS_IN: TEST_ADDRESS,
  PLATFORM_TAX_REGION: 'Telangana',
};
type Env = Record<string, string | undefined>;
const getter = (env: Env) => (k: string) => env[k];
const configOf = (env: Env) => ({ get: getter(env) }) as never;

describe('the declared GST status', () => {
  it('is explicit: unset or unknown is UNVERIFIED, case is tolerated', () => {
    expect(configuredGstStatus(getter({}))).toBe('UNVERIFIED');
    expect(configuredGstStatus(getter({ BILLING_SELLER_GST_STATUS_IN: 'maybe' }))).toBe(
      'UNVERIFIED',
    );
    expect(configuredGstStatus(getter({ BILLING_SELLER_GST_STATUS_IN: ' unregistered ' }))).toBe(
      'UNREGISTERED',
    );
  });

  it('PRODUCTION treats UNVERIFIED as refused; QA picks by whether a GSTIN is set', () => {
    expect(effectiveGstStatus(getter({ APP_ENV: 'PRODUCTION' }))).toBeNull();
    expect(
      effectiveGstStatus(getter({ APP_ENV: 'PRODUCTION', BILLING_SELLER_GSTIN_IN: TEST_GSTIN_TG })),
    ).toBeNull();
    expect(effectiveGstStatus(getter({ APP_ENV: 'QA' }))).toBe('UNREGISTERED');
    expect(
      effectiveGstStatus(getter({ APP_ENV: 'QA', BILLING_SELLER_GSTIN_IN: TEST_GSTIN_TG })),
    ).toBe('REGISTERED');
    expect(effectiveGstStatus(getter({ APP_ENV: 'PRODUCTION', ...UNREGISTERED }))).toBe(
      'UNREGISTERED',
    );
  });
});

describe('what each status needs (PRODUCTION standard)', () => {
  it('UNVERIFIED: one problem that names the variable to set', () => {
    expect(
      indiaSellerProblems(getter({ ...REGISTERED, BILLING_SELLER_GST_STATUS_IN: '' })),
    ).toEqual([expect.stringMatching(/BILLING_SELLER_GST_STATUS_IN is UNVERIFIED.*REGISTERED or/)]);
  });

  it('UNREGISTERED needs the address and state only - no GSTIN, no SAC', () => {
    expect(indiaSellerProblems(getter(UNREGISTERED))).toEqual([]);
    const out = indiaSellerProblems(getter({ BILLING_SELLER_GST_STATUS_IN: 'UNREGISTERED' }));
    expect(out.join('\n')).toMatch(/BILLING_SELLER_ADDRESS_IN is not set/);
    expect(out.join('\n')).toMatch(/PLATFORM_TAX_REGION is not set/);
    expect(out.join('\n')).not.toMatch(/GSTIN|SAC/);
  });

  it('UNREGISTERED with a GSTIN set is a contradiction', () => {
    expect(
      indiaSellerProblems(getter({ ...UNREGISTERED, BILLING_SELLER_GSTIN_IN: TEST_GSTIN_TG })),
    ).toEqual([expect.stringMatching(/GSTIN_IN is set but .* is UNREGISTERED/)]);
  });

  it('REGISTERED keeps every GST tax invoice requirement', () => {
    expect(indiaSellerProblems(getter(REGISTERED))).toEqual([]);
    const out = indiaSellerProblems(
      getter({ ...REGISTERED, BILLING_SELLER_GSTIN_IN: undefined, BILLING_SELLER_SAC_IN: '' }),
    ).join('\n');
    expect(out).toMatch(/BILLING_SELLER_GSTIN_IN is not set/);
    expect(out).toMatch(/BILLING_SELLER_SAC_IN is not set/);
  });

  it('an unregistered snapshot never carries a GSTIN or SAC, whatever is configured', () => {
    const d = indiaSellerDetails(
      getter({
        ...UNREGISTERED,
        BILLING_SELLER_GSTIN_IN: TEST_GSTIN_TG,
        BILLING_SELLER_SAC_IN: TEST_SAC,
      }),
    );
    expect(d).toMatchObject({
      gstStatus: 'UNREGISTERED',
      gstin: null,
      sac: null,
      address: TEST_ADDRESS,
      state: 'Telangana',
      legalName: 'DeepTrics Software Solutions Private Limited',
    });
  });
});

describe('PRODUCTION refusals', () => {
  const prod = (env: Env) => getter({ APP_ENV: 'PRODUCTION', ...env });

  it('runtime: UNVERIFIED is refused and says which variable to set', () => {
    let err: unknown;
    try {
      assertIndiaSellerReady(
        prod({ ...REGISTERED, BILLING_SELLER_GST_STATUS_IN: undefined }),
        'IN',
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppException);
    expect(JSON.stringify((err as AppException).getResponse())).toMatch(
      /BILLING_SELLER_GST_STATUS_IN/,
    );
  });

  it('runtime: UNREGISTERED with a GSTIN is refused; a clean UNREGISTERED passes', () => {
    expect(() =>
      assertIndiaSellerReady(
        prod({ ...UNREGISTERED, BILLING_SELLER_GSTIN_IN: TEST_GSTIN_TG }),
        'IN',
      ),
    ).toThrow(/cannot issue an invoice/);
    expect(() => assertIndiaSellerReady(prod(UNREGISTERED), 'IN')).not.toThrow();
    expect(() => assertIndiaSellerReady(prod(REGISTERED), 'IN')).not.toThrow();
  });

  const BOOT = {
    APP_ENV: 'PRODUCTION',
    BILLING_ENABLED: 'true',
    BILLING_PROVIDER: 'providers',
    BILLING_LIVE_ENABLED: 'true',
    BILLING_LIVE_MARKETS: 'IN',
    RAZORPAY_BILLING_KEY_ID: 'rzp_live_KEYID',
    RAZORPAY_BILLING_KEY_SECRET: 'rzpsecretVALUE',
    RAZORPAY_BILLING_WEBHOOK_SECRET: 'rzpwebhookVALUE',
  };

  it('boot: UNVERIFIED with IN live is refused, naming BILLING_SELLER_GST_STATUS_IN', () => {
    expect(
      billingConfigurationErrors({ ...BOOT, ...REGISTERED, BILLING_SELLER_GST_STATUS_IN: '' }).join(
        '\n',
      ),
    ).toMatch(/BILLING_SELLER_GST_STATUS_IN is UNVERIFIED/);
    expect(billingConfigurationErrors(BOOT).join('\n')).toMatch(/BILLING_SELLER_GST_STATUS_IN/);
  });

  it('boot: UNREGISTERED boots with address + state, and is refused with a GSTIN', () => {
    expect(billingConfigurationErrors({ ...BOOT, ...UNREGISTERED })).toEqual([]);
    expect(
      billingConfigurationErrors({
        ...BOOT,
        ...UNREGISTERED,
        BILLING_SELLER_GSTIN_IN: TEST_GSTIN_TG,
      }).join('\n'),
    ).toMatch(/unregistered supplier has no GSTIN/);
    expect(billingConfigurationErrors({ ...BOOT, ...REGISTERED })).toEqual([]);
  });
});

// ── The tax engine ────────────────────────────────────────────────────────────────

const GST_RULE = {
  id: 'tr_test_18',
  label: 'GST',
  rateBasisPoints: 1800, // TEST assumption only
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

function taxPrisma() {
  return {
    organization: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ registeredRegion: 'Telangana', registeredCountry: 'IN' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Org', legalName: null }),
    },
    taxRule: { findMany: jest.fn().mockResolvedValue([GST_RULE]) },
  };
}

const quoteIn = (env: Env) => {
  const prisma = taxPrisma();
  const svc = new BillingTaxService(prisma as never, configOf(env));
  return {
    prisma,
    run: () =>
      svc.quote({ organizationId: 'org-1', country: 'IN', currency: 'INR', amountMinor: 99900 }),
  };
};

describe('GST on organizer billing, per seller status', () => {
  it('UNREGISTERED: no GST - the active PLATFORM_SERVICES rule is not even read', async () => {
    const { prisma, run } = quoteIn(UNREGISTERED);
    const q = await run();
    expect(q).toMatchObject({
      mode: 'MANUAL',
      netMinor: 99900,
      taxMinor: 0,
      totalMinor: 99900,
      lines: [],
      sellerGstStatus: 'UNREGISTERED',
    });
    expect(prisma.taxRule.findMany).not.toHaveBeenCalled();
  });

  it('REGISTERED: GST from the rule (TEST 18%), CGST + SGST', async () => {
    const q = await quoteIn(REGISTERED).run();
    expect(q.totalMinor).toBe(117882);
    expect(q.sellerGstStatus).toBe('REGISTERED');
    expect(q.lines.map((l) => l.label)).toEqual(['CGST', 'SGST']);
  });

  it('PRODUCTION + UNVERIFIED: refused, never a guessed zero or rate', async () => {
    await expect(
      quoteIn({
        APP_ENV: 'PRODUCTION',
        ...REGISTERED,
        BILLING_SELLER_GST_STATUS_IN: undefined,
      }).run(),
    ).rejects.toThrow(/closed in India/);
  });

  it('other countries are untouched', async () => {
    const prisma = taxPrisma();
    prisma.taxRule.findMany.mockResolvedValue([
      { ...GST_RULE, country: 'US', split: 'NONE', label: 'Sales tax', currency: 'USD' },
    ]);
    const q = await new BillingTaxService(prisma as never, configOf(UNREGISTERED)).quote({
      organizationId: 'org-1',
      country: 'US',
      currency: 'USD',
      amountMinor: 1000,
    });
    expect(q.sellerGstStatus).toBeNull();
    expect(q.taxMinor).toBe(180);
  });
});

// ── The quote, the provider plan and the checkout ───────────────────────────────────

const PRICE = {
  id: 'bp_pro_m_in',
  active: true,
  country: 'IN',
  currency: 'INR',
  amountMinor: 99900,
  interval: 'MONTH',
  providerPriceRefTest: 'plan_TEST_pro_m',
  providerPriceRefLive: null,
};

function checkout(env: Env, planAmountMinor: number) {
  const state = razorpayState();
  state.plans.plan_TEST_pro_m = {
    id: 'plan_TEST_pro_m',
    period: 'monthly',
    interval: 1,
    item: { amount: planAmountMinor, currency: 'INR' },
  };
  const p = new RazorpaySubscriptionsProvider({
    keyId: 'rzp_test_x',
    keySecret: 'secret',
    webhookSecret: RAZORPAY_TEST_WEBHOOK_SECRET,
    mode: 'test',
    mandateMaxMinor: 1_500_000,
    upiAutopay: false,
    client: fakeRazorpay(state),
  }) as unknown as BillingProvider;
  const account = {
    id: 'acc',
    organizationId: 'org-1',
    country: 'IN',
    provider: 'RAZORPAY_BILLING',
  };
  const prisma = {
    ...taxPrisma(),
    organizerBillingAccount: {
      findUnique: jest.fn().mockResolvedValue(account),
      update: jest.fn(),
    },
    organizerSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
    billingPrice: { findUnique: jest.fn().mockResolvedValue(PRICE) },
    $transaction: jest.fn().mockImplementation(async () => account),
  };
  const config = configOf({ BILLING_ENABLED: 'true', ...env });
  const svc = new BillingCheckoutService(
    prisma as never,
    config,
    BillingProviderRegistry.fixed(p, { RAZORPAY_BILLING: p }),
    {} as never,
    new BillingTaxService(prisma as never, config),
    {} as never,
  );
  return { svc, state };
}

describe('chargeMatches: the Razorpay plan must charge exactly the quote', () => {
  it('UNREGISTERED: the 99900 plan matches; the GST-inclusive 117882 plan does not', async () => {
    const ok = await checkout(UNREGISTERED, 99900).svc.quotePlan('org-1', PRICE.id);
    expect(ok).toMatchObject({
      totalMinor: 99900,
      taxMinor: 0,
      lines: [],
      providerChargeMinor: 99900,
      chargeMatches: true,
      sellerGstStatus: 'UNREGISTERED',
    });
    const wrong = await checkout(UNREGISTERED, 117882).svc.quotePlan('org-1', PRICE.id);
    expect(wrong.chargeMatches).toBe(false);
  });

  it('REGISTERED: the 117882 plan matches; the 99900 plan does not', async () => {
    expect(
      (await checkout(REGISTERED, 117882).svc.quotePlan('org-1', PRICE.id)).chargeMatches,
    ).toBe(true);
    expect((await checkout(REGISTERED, 99900).svc.quotePlan('org-1', PRICE.id)).chargeMatches).toBe(
      false,
    );
  });

  it('the checkout itself is refused on a mismatch, and goes through on the 99900 plan', async () => {
    const bad = checkout(UNREGISTERED, 117882);
    await expect(bad.svc.startPlanCheckout('org-1', PRICE.id)).rejects.toThrow(
      /plan does not match this price/,
    );
    expect(bad.state.calls.some((c) => c.method === 'subscriptions.create')).toBe(false);
    const good = checkout(UNREGISTERED, 99900);
    await expect(good.svc.startPlanCheckout('org-1', PRICE.id)).resolves.toMatchObject({
      provider: 'RAZORPAY_BILLING',
    });
  });

  it('PRODUCTION: UNVERIFIED refuses quote and checkout; UNREGISTERED + GSTIN refuses too', async () => {
    const prodUnverified = checkout(
      { APP_ENV: 'PRODUCTION', ...REGISTERED, BILLING_SELLER_GST_STATUS_IN: undefined },
      99900,
    );
    await expect(prodUnverified.svc.quotePlan('org-1', PRICE.id)).rejects.toThrow(
      /closed in India/,
    );
    await expect(prodUnverified.svc.startPlanCheckout('org-1', PRICE.id)).rejects.toThrow(
      /closed in India/,
    );
    const contradiction = checkout(
      { APP_ENV: 'PRODUCTION', ...UNREGISTERED, BILLING_SELLER_GSTIN_IN: TEST_GSTIN_TG },
      99900,
    );
    await expect(contradiction.svc.startPlanCheckout('org-1', PRICE.id)).rejects.toThrow(
      /cannot issue an invoice/,
    );
  });
});

// ── The invoice ─────────────────────────────────────────────────────────────────

function invoiceTx() {
  const create = jest.fn().mockImplementation(({ data }) => data);
  const counter = jest.fn().mockResolvedValue([{ value: 1 }]);
  return {
    create,
    counter,
    tx: {
      organizerInvoice: { findUnique: jest.fn().mockResolvedValue(null), create },
      organizerBillingAccount: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'acc', organizationId: 'org-1', country: 'IN', taxId: null }),
      },
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          name: 'Test Org',
          legalName: 'Test Org Private Limited',
          registeredRegion: 'Karnataka',
        }),
      },
      $queryRaw: counter,
    },
  };
}

const PAID_NO_GST = {
  accountId: 'acc',
  provider: 'RAZORPAY_BILLING' as const,
  providerInvoiceRef: 'inv_TEST1',
  paymentRef: 'pay_TEST1',
  currency: 'INR',
  lines: [{ description: 'Pro plan, monthly', quantity: 1, unitAmountMinor: 99900 }],
  taxMinor: 0,
  tax: {
    lines: [],
    mode: 'MANUAL' as const,
    jurisdiction: {
      country: 'IN',
      region: 'Karnataka',
      sellerRegion: 'Telangana',
      interState: null,
    },
  },
  paidAt: new Date('2026-11-01T10:00:00.000Z'),
};

async function issue(env: Env, input = PAID_NO_GST) {
  const t = invoiceTx();
  await new BillingInvoiceService({} as never, configOf(env)).recordPaidInTx(t.tx as never, input);
  return { t, doc: t.create.mock.calls[0]?.[0].data.documentJson as Record<string, unknown> };
}

function render(doc: Record<string, unknown>, status = 'PAID') {
  const facts = invoiceDocumentFacts(doc);
  return renderBillingInvoiceHtml({
    number: String(doc.number),
    status,
    issuedAt: new Date(String(doc.issuedAt)),
    currency: 'INR',
    lines: doc.lines as never,
    subtotalMinor: Number(doc.subtotalMinor),
    taxMinor: Number(doc.taxMinor),
    totalMinor: Number(doc.totalMinor),
    taxLines: (doc.taxLines ?? []) as never,
    placeOfSupply: 'Karnataka, IN',
    periodStart: null,
    periodEnd: null,
    sellerName: String((doc.seller as { legalName: string }).legalName),
    seller: facts.seller,
    paymentRef: facts.paymentRef,
    billedTo: {
      name: facts.buyer?.name ?? 'x',
      country: 'IN',
      taxId: null,
      email: null,
      state: facts.buyer?.state ?? null,
    },
  });
}

describe('the unregistered seller invoice', () => {
  it('freezes the status and the seller without GSTIN or SAC, with the no-GST note', async () => {
    const { doc } = await issue({ ...UNREGISTERED, BILLING_SELLER_SAC_IN: TEST_SAC });
    expect(doc.sellerGstStatus).toBe('UNREGISTERED');
    expect(doc.seller).toMatchObject({
      legalName: 'DeepTrics Software Solutions Private Limited',
      gstStatus: 'UNREGISTERED',
      gstin: null,
      sac: null,
      address: TEST_ADDRESS,
      state: 'Telangana',
    });
    expect(doc.taxNote).toBe(GST_NOT_CHARGED_NOTE);
    expect(doc.totalMinor).toBe(99900);
    expect(doc.paymentRef).toBe('pay_TEST1');
  });

  it('QA UNVERIFIED without a GSTIN is issued as unregistered', async () => {
    const { doc } = await issue({ APP_ENV: 'QA', BILLING_SELLER_ADDRESS_IN: TEST_ADDRESS });
    expect(doc.sellerGstStatus).toBe('UNREGISTERED');
  });

  it('prints an ordinary "Invoice": seller, address, buyer, amount, total, payment ref, the note', async () => {
    const { doc } = await issue(UNREGISTERED);
    const html = render(doc);
    expect(html).toContain('<h1>Invoice</h1>');
    expect(html).not.toMatch(/Tax invoice/i);
    expect(html).toContain('DeepTrics Software Solutions Private Limited');
    expect(html).toContain(TEST_ADDRESS);
    expect(html).toContain('Test Org Private Limited');
    expect(html).toContain('Payment reference: pay_TEST1.');
    expect(html).toContain('Place of supply: Karnataka, IN.');
    expect(html).toContain(GST_NOT_CHARGED_NOTE);
    expect(html).toMatch(/Total<\/th><td class="num">[^<]*999(\.00)?<\/td>/);
    expect(html).not.toMatch(/GSTIN|SAC|CGST|SGST|IGST/);
    expect(html).not.toContain('<th colspan="3">Tax</th>');
    expect(html).not.toContain(TAX_NOT_APPLIED_NOTE);
  });

  it('never carries GST: an unregistered invoice with tax is refused before a number is taken', async () => {
    const t = invoiceTx();
    const svc = new BillingInvoiceService({} as never, configOf(UNREGISTERED));
    await expect(
      svc.recordPaidInTx(t.tx as never, {
        ...PAID_NO_GST,
        taxMinor: 17982,
        tax: {
          ...PAID_NO_GST.tax,
          lines: [
            { label: 'IGST', rateBasisPoints: 1800, baseMinor: 99900, amountMinor: 17982 },
          ] as never,
        },
      }),
    ).rejects.toThrow(/not registered under GST cannot carry tax/);
    expect(t.counter).not.toHaveBeenCalled();
  });

  it('PRODUCTION UNVERIFIED: no invoice, no number taken', async () => {
    const t = invoiceTx();
    const svc = new BillingInvoiceService(
      {} as never,
      configOf({
        APP_ENV: 'PRODUCTION',
        BILLING_SELLER_ADDRESS_IN: TEST_ADDRESS,
        PLATFORM_TAX_REGION: 'Telangana',
      }),
    );
    await expect(svc.recordPaidInTx(t.tx as never, PAID_NO_GST)).rejects.toThrow(AppException);
    expect(t.counter).not.toHaveBeenCalled();
  });

  it('a refunded or void unregistered invoice is still never a tax document', async () => {
    const { doc } = await issue(UNREGISTERED);
    for (const status of ['REFUNDED', 'VOID']) {
      const html = render(doc, status);
      expect(html).not.toMatch(/Tax invoice|credit note|GST credit/i);
      expect(html).toContain('<h1>Invoice</h1>');
    }
  });
});

describe('the registered seller invoice', () => {
  it('freezes REGISTERED and prints a tax invoice with GSTIN and SAC', async () => {
    const { doc } = await issue(REGISTERED, {
      ...PAID_NO_GST,
      taxMinor: 17982,
      tax: {
        ...PAID_NO_GST.tax,
        lines: [
          { label: 'IGST', rateBasisPoints: 1800, baseMinor: 99900, amountMinor: 17982 },
        ] as never,
      },
    });
    expect(doc.sellerGstStatus).toBe('REGISTERED');
    const html = render(doc);
    expect(html).toContain('<h1>Tax invoice</h1>');
    expect(html).toContain(`GSTIN: ${TEST_GSTIN_TG}`);
    expect(html).toContain('SAC: 990000.');
    expect(html).toContain('IGST (18%)');
    expect(html).not.toContain(GST_NOT_CHARGED_NOTE);
  });
});

describe('snapshots are immutable', () => {
  it('an unregistered invoice still renders as one after the seller registers', async () => {
    const { doc } = await issue(UNREGISTERED);
    const stored = JSON.parse(JSON.stringify(doc));
    // Configuration changes later; the stored document is what renders.
    const html = render(stored);
    expect(html).toContain('<h1>Invoice</h1>');
    expect(html).toContain(GST_NOT_CHARGED_NOTE);
    expect(invoiceDocumentFacts(stored).seller?.gstStatus).toBe('UNREGISTERED');
  });

  it('an invoice issued before the status was recorded renders as it did', () => {
    const old = {
      seller: {
        legalName: 'DeepTrics Software Solutions Private Limited',
        gstin: TEST_GSTIN_TG,
        sac: TEST_SAC,
        address: TEST_ADDRESS,
        state: 'Telangana',
        stateCode: '36',
      },
    };
    expect(invoiceDocumentFacts(old).seller?.gstStatus).toBeNull();
    expect(invoiceDocumentFacts(old).seller?.gstin).toBe(TEST_GSTIN_TG);
  });
});

describe('an invoice service without configuration', () => {
  it('records no GST status rather than guessing one, so a taxed payment still invoices', async () => {
    const t = invoiceTx();
    await new BillingInvoiceService({} as never).recordPaidInTx(t.tx as never, {
      ...PAID_NO_GST,
      taxMinor: 17982,
      tax: {
        ...PAID_NO_GST.tax,
        lines: [
          { label: 'IGST', rateBasisPoints: 1800, baseMinor: 99900, amountMinor: 17982 },
        ] as never,
      },
    });
    const doc = t.create.mock.calls[0][0].data.documentJson as Record<string, unknown>;
    expect(doc.sellerGstStatus).toBeNull();
    expect(doc.taxNote).toBeNull();
  });
});
