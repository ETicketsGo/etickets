import { BillingCheckoutService } from './billing-checkout.service';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import type { BillingProvider, ProviderSubscriptionRecord } from './provider/billing-provider';
import {
  RAZORPAY_CHECKOUT_EXPIRY_SECONDS,
  RazorpaySubscriptionsProvider,
} from './provider/razorpay-subscriptions.provider';
import {
  RAZORPAY_TEST_WEBHOOK_SECRET,
  fakeRazorpay,
  razorpayState,
  razorpaySubscription,
} from './provider/billing-provider.fixture';
import type { BillingTaxQuote } from './billing-tax.service';

/**
 * The Indian plan checkout around the provider: the quote shown before paying and whether
 * the provider plan charges the same, the PRODUCTION refusal while a GST tax invoice could not
 * be issued, and the "waiting for your payment" status - which never reports a plan active
 * unless OUR subscription is.
 */
const QUOTE: BillingTaxQuote = {
  mode: 'MANUAL',
  currency: 'INR',
  netMinor: 99900,
  taxMinor: 17982,
  totalMinor: 117882,
  lines: [
    { label: 'CGST', rateBasisPoints: 900, baseMinor: 99900, amountMinor: 8991 },
    { label: 'SGST', rateBasisPoints: 900, baseMinor: 99900, amountMinor: 8991 },
  ],
  sellerGstStatus: 'REGISTERED',
  jurisdiction: {
    country: 'IN',
    region: 'Telangana',
    sellerRegion: 'Telangana',
    interState: false,
  },
};

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

function provider(over: Partial<BillingProvider> = {}): BillingProvider {
  return {
    key: 'RAZORPAY_BILLING',
    enabled: true,
    mode: 'test',
    createCheckout: jest.fn().mockResolvedValue({
      provider: 'RAZORPAY_BILLING',
      sessionRef: 'sub_TESTPROBE01',
      url: 'https://rzp.test/i/sub_TESTPROBE01',
    }),
    verifyWebhook: jest.fn(),
    fetchPayment: jest.fn(),
    planCharge: jest.fn().mockResolvedValue({ amountMinor: 117882, currency: 'INR' }),
    ...over,
  } as unknown as BillingProvider;
}

function service(opts: {
  env?: Record<string, string>;
  p?: BillingProvider;
  sub?: Record<string, unknown> | null;
  account?: Record<string, unknown> | null;
}) {
  const p = opts.p ?? provider();
  const account =
    opts.account === undefined
      ? { id: 'acc', organizationId: 'org-1', country: 'IN', provider: 'RAZORPAY_BILLING' }
      : opts.account;
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue({ registeredCountry: 'IN' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Org', legalName: null }),
    },
    organizerBillingAccount: {
      findUnique: jest.fn().mockResolvedValue(account),
      update: jest.fn(),
    },
    organizerSubscription: { findUnique: jest.fn().mockResolvedValue(opts.sub ?? null) },
    billingPrice: { findUnique: jest.fn().mockResolvedValue(PRICE) },
    $transaction: jest.fn().mockImplementation(async () => account),
  };
  const env = { BILLING_ENABLED: 'true', ...(opts.env ?? {}) };
  const tax = { quote: jest.fn().mockResolvedValue(QUOTE) };
  const svc = new BillingCheckoutService(
    prisma as never,
    { get: (k: string) => (env as Record<string, string>)[k] } as never,
    BillingProviderRegistry.fixed(p, { RAZORPAY_BILLING: p }),
    {} as never,
    tax as never,
    {} as never,
  );
  return { svc, p, prisma, tax };
}

describe('the quote shown before paying', () => {
  it('itemises base, CGST and SGST with rates, and the total the provider plan charges', async () => {
    const { svc } = service({});
    const q = await svc.quotePlan('org-1', PRICE.id);
    expect(q).toMatchObject({
      currency: 'INR',
      interval: 'MONTH',
      netMinor: 99900,
      taxMinor: 17982,
      totalMinor: 117882,
      lines: [
        { label: 'CGST', rateBasisPoints: 900, amountMinor: 8991 },
        { label: 'SGST', rateBasisPoints: 900, amountMinor: 8991 },
      ],
      providerChargeMinor: 117882,
      chargeMatches: true,
    });
  });

  it('says so when the provider plan would charge a different amount', async () => {
    const p = provider({
      planCharge: jest.fn().mockResolvedValue({ amountMinor: 99900, currency: 'INR' }),
    } as Partial<BillingProvider>);
    const q = await service({ p }).svc.quotePlan('org-1', PRICE.id);
    expect(q.chargeMatches).toBe(false);
  });

  it('does not guess when the provider plan cannot be read', async () => {
    const p = provider({
      planCharge: jest.fn().mockRejectedValue(new Error('down')),
    } as Partial<BillingProvider>);
    const q = await service({ p }).svc.quotePlan('org-1', PRICE.id);
    expect(q.providerChargeMinor).toBeNull();
    expect(q.chargeMatches).toBeNull();
  });
});

describe('PRODUCTION: no Indian checkout without a GST tax invoice', () => {
  it('refuses before the provider is asked when the seller facts are missing', async () => {
    const { svc, p } = service({
      env: { APP_ENV: 'PRODUCTION', BILLING_SELLER_GST_STATUS_IN: 'REGISTERED' },
    });
    await expect(svc.startPlanCheckout('org-1', PRICE.id)).rejects.toThrow(
      /cannot issue a GST tax invoice/,
    );
    await expect(svc.quotePlan('org-1', PRICE.id)).rejects.toThrow(
      /cannot issue a GST tax invoice/,
    );
    expect(p.createCheckout).not.toHaveBeenCalled();
  });

  it('refuses an invalid GSTIN too', async () => {
    const { svc } = service({
      env: {
        APP_ENV: 'PRODUCTION',
        BILLING_SELLER_GST_STATUS_IN: 'REGISTERED',
        BILLING_SELLER_GSTIN_IN: '36TESTA0000T1ZA', // TEST, wrong check character
        BILLING_SELLER_SAC_IN: '990000',
        BILLING_SELLER_ADDRESS_IN: 'TEST ONLY, 1 Test Street, Hyderabad 500001',
        PLATFORM_TAX_REGION: 'Telangana',
      },
    });
    await expect(svc.startPlanCheckout('org-1', PRICE.id)).rejects.toThrow(
      /cannot issue a GST tax invoice/,
    );
  });

  it('QA (test keys) is not held up by them', async () => {
    const { svc, p } = service({
      env: { APP_ENV: 'QA', ORGANIZER_WEB_URL: 'https://organizer.test' },
    });
    await svc.startPlanCheckout('org-1', PRICE.id);
    expect(p.createCheckout).toHaveBeenCalled();
  });
});

describe('waiting for a payment made in another tab', () => {
  const rec = (status: ProviderSubscriptionRecord['status'], organizationId = 'org-1') =>
    ({
      verified: true,
      provider: 'RAZORPAY_BILLING',
      subscriptionRef: 'sub_TESTPROBE01',
      customerRef: null,
      status,
      providerPriceRef: 'plan_TEST_pro_m',
      cancelAtPeriodEnd: null,
      periodStart: null,
      periodEnd: null,
      organizationId,
      latestPaidPaymentRef: null,
    }) as ProviderSubscriptionRecord;
  const withProviderStatus = (status: ProviderSubscriptionRecord['status'], org?: string) =>
    provider({ fetchSubscription: jest.fn().mockResolvedValue(rec(status, org)) } as never);

  it('provider says paid, our plan is not active yet: PROCESSING, never ACTIVE', async () => {
    const { svc } = service({ p: withProviderStatus('ACTIVE') });
    expect(await svc.checkoutStatus('org-1', 'sub_TESTPROBE01')).toEqual({
      state: 'PROCESSING',
      planActive: false,
    });
  });

  it('ACTIVE only when OUR subscription for that checkout is live', async () => {
    const { svc } = service({
      p: withProviderStatus('ACTIVE'),
      sub: { source: 'PROVIDER', status: 'ACTIVE', providerSubscriptionRef: 'sub_TESTPROBE01' },
    });
    expect(await svc.checkoutStatus('org-1', 'sub_TESTPROBE01')).toEqual({
      state: 'ACTIVE',
      planActive: true,
    });
  });

  it('not paid yet, failed and abandoned pages each say so', async () => {
    expect(
      (
        await service({ p: withProviderStatus('INCOMPLETE') }).svc.checkoutStatus(
          'org-1',
          'sub_TESTPROBE01',
        )
      ).state,
    ).toBe('PENDING');
    expect(
      (
        await service({ p: withProviderStatus('HALTED') }).svc.checkoutStatus(
          'org-1',
          'sub_TESTPROBE01',
        )
      ).state,
    ).toBe('FAILED');
    expect(
      (
        await service({ p: withProviderStatus('CANCELLED') }).svc.checkoutStatus(
          'org-1',
          'sub_TESTPROBE01',
        )
      ).state,
    ).toBe('EXPIRED');
  });

  it("another organization's checkout is not found, and junk refs never reach the provider", async () => {
    const p = withProviderStatus('ACTIVE', 'org-2');
    await expect(service({ p }).svc.checkoutStatus('org-1', 'sub_TESTPROBE01')).rejects.toThrow(
      /not found/,
    );
    const q = withProviderStatus('ACTIVE');
    expect(await service({ p: q }).svc.checkoutStatus('org-1', '?checkout=success')).toEqual({
      state: 'UNKNOWN',
      planActive: false,
    });
    expect(q.fetchSubscription).not.toHaveBeenCalled();
  });
});

describe('Razorpay subscription checkout and cancellation', () => {
  function rzp() {
    const state = razorpayState();
    state.plans.plan_TEST_pro_m = {
      id: 'plan_TEST_pro_m',
      period: 'monthly',
      interval: 1,
      item: { amount: 117882, currency: 'INR' },
    };
    const p = new RazorpaySubscriptionsProvider({
      keyId: 'rzp_test_x',
      keySecret: 'secret',
      webhookSecret: RAZORPAY_TEST_WEBHOOK_SECRET,
      mode: 'test',
      mandateMaxMinor: 1_500_000,
      upiAutopay: false,
      client: fakeRazorpay(state),
    });
    return { p, state };
  }

  it('sends no return URL (Razorpay refuses one) and lets an abandoned page expire', async () => {
    const { p, state } = rzp();
    const before = Math.floor(Date.now() / 1000);
    await p.createCheckout({
      organizationId: 'org-1',
      accountId: 'acc',
      priceId: PRICE.id,
      country: 'IN',
      currency: 'INR',
      amountMinor: 99900,
      interval: 'MONTH',
      providerPriceRef: 'plan_TEST_pro_m',
      customerRef: null,
      successUrl: 'https://o.test/organizer/billing?checkout=success',
      cancelUrl: 'https://o.test/organizer/billing?checkout=cancelled',
      tax: QUOTE,
    });
    const [params] = state.calls.find((c) => c.method === 'subscriptions.create')!.args as [
      Record<string, unknown>,
    ];
    expect(params).not.toHaveProperty('callback_url');
    expect(params).not.toHaveProperty('redirect_url');
    expect(params.expire_by).toBeGreaterThanOrEqual(before + RAZORPAY_CHECKOUT_EXPIRY_SECONDS);
  });

  it('cancels at the END of the cycle (cancel_at_cycle_end), never immediately', async () => {
    const { p, state } = rzp();
    state.subs.sub_TESTPROBE01 = razorpaySubscription({
      id: 'sub_TESTPROBE01',
      customer: 'cust_TEST',
      plan: 'plan_TEST_pro_m',
      organizationId: 'org-1',
      start: new Date('2026-11-01T00:00:00Z'),
      end: new Date('2026-12-01T00:00:00Z'),
    });
    const r = await p.cancelAtPeriodEnd('sub_TESTPROBE01');
    expect(state.calls.find((c) => c.method === 'subscriptions.cancel')!.args).toEqual([
      'sub_TESTPROBE01',
      true,
    ]);
    // Razorpay answers a cycle-end cancel with the subscription still active.
    expect(r).toMatchObject({ status: 'ACTIVE', cancelAtPeriodEnd: true });
  });

  it('reads what the plan charges, for the quote', async () => {
    const { p } = rzp();
    expect(await p.planCharge('plan_TEST_pro_m')).toEqual({ amountMinor: 117882, currency: 'INR' });
  });
});
