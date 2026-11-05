import { StripeBillingProvider } from './stripe-billing.provider';
import { RazorpaySubscriptionsProvider } from './razorpay-subscriptions.provider';
import { BillingProviderRegistry } from './billing-provider.registry';
import { DisabledBillingProvider, MockBillingProvider } from './billing-provider';
import { assertUsableKey, keyModeOf, resolveCredential } from './billing-credentials';
import { BillingCheckoutService } from '../billing-checkout.service';
import {
  RAZORPAY_TEST_WEBHOOK_SECRET,
  STRIPE_TEST_WEBHOOK_SECRET,
  fakeRazorpay,
  fakeStripe,
  razorpayEvent,
  razorpayState,
  razorpaySubscription,
  signRazorpay,
  signStripe,
  stripeCreditPackSession,
  stripeEvent,
  stripeInvoice,
  stripeState,
  stripeSubscription,
} from './billing-provider.fixture';

/**
 * The two real billing providers, offline. Signatures are made with the providers' own schemes
 * (Stripe's SDK test helper, Razorpay's documented HMAC-SHA256 over the raw body); every
 * provider API answer comes from recorded-shape fixtures. No network.
 */
const start = new Date('2026-11-01T00:00:00Z');
const end = new Date('2026-12-01T00:00:00Z');

function stripe(state = stripeState()) {
  return {
    state,
    p: new StripeBillingProvider({
      secretKey: 'sk_test_x',
      webhookSecret: STRIPE_TEST_WEBHOOK_SECRET,
      mode: 'test',
      client: fakeStripe(state),
    }),
  };
}

function razorpay(state = razorpayState(), mandateMaxMinor = 1_500_000) {
  return {
    state,
    p: new RazorpaySubscriptionsProvider({
      keyId: 'rzp_test_x',
      keySecret: 'secret',
      webhookSecret: RAZORPAY_TEST_WEBHOOK_SECRET,
      mode: 'test',
      mandateMaxMinor,
      upiAutopay: false,
      client: fakeRazorpay(state),
    }),
  };
}

describe('Stripe Billing: webhook signatures', () => {
  const invoice = stripeInvoice({
    id: 'in_1',
    customer: 'cus_1',
    subscription: 'sub_1',
    organizationId: 'org_1',
    price: 'price_pro_m',
    amount: 2900,
    currency: 'USD',
    start,
    end,
  });

  it('accepts a correctly signed event and maps invoice.paid to a payment claim', async () => {
    const { p } = stripe();
    const { raw, headers } = signStripe(stripeEvent('evt_1', 'invoice.paid', invoice));
    const ev = await p.verifyWebhook(raw, headers);
    expect(ev).toMatchObject({
      provider: 'STRIPE_BILLING',
      providerEventId: 'evt_1',
      type: 'PAYMENT_CAPTURED',
      paymentRef: 'in_1',
      providerSubscriptionRef: 'sub_1',
      organizationId: 'org_1',
      providerType: 'invoice.paid',
    });
    expect(ev.occurredAt).toBeDefined();
  });

  it('refuses a body changed after signing, a wrong secret, and a missing header', async () => {
    const { p } = stripe();
    const { raw, headers } = signStripe(stripeEvent('evt_1', 'invoice.paid', invoice));
    const tampered = raw.replace('"amount_paid":2900', '"amount_paid":1');
    await expect(p.verifyWebhook(tampered, headers)).rejects.toMatchObject({
      code: 'BILLING_WEBHOOK_INVALID',
    });
    const other = signStripe(stripeEvent('evt_1', 'invoice.paid', invoice), 'whsec_other');
    await expect(p.verifyWebhook(other.raw, other.headers)).rejects.toMatchObject({
      code: 'BILLING_WEBHOOK_INVALID',
    });
    await expect(p.verifyWebhook(raw, {})).rejects.toMatchObject({
      code: 'BILLING_WEBHOOK_INVALID',
    });
  });

  it('maps every subscribed event type, and ignores what billing does not use', () => {
    const { p } = stripe();
    const sub = stripeSubscription({
      id: 'sub_1',
      customer: 'cus_1',
      price: 'price_pro_m',
      organizationId: 'org_1',
      start,
      end,
    });
    const type = (t: string, o: Record<string, unknown>) =>
      p.parseEvent(stripeEvent('e', t, o)).type;
    expect(type('customer.subscription.created', sub)).toBe('SUBSCRIPTION_UPDATED');
    expect(type('customer.subscription.updated', sub)).toBe('SUBSCRIPTION_UPDATED');
    expect(type('customer.subscription.deleted', sub)).toBe('SUBSCRIPTION_CANCELLED');
    expect(type('invoice.payment_failed', invoice)).toBe('PAYMENT_FAILED');
    expect(type('invoice.finalized', invoice)).toBe('INVOICE_FINALIZED');
    expect(type('charge.dispute.created', { id: 'dp_1' })).toBe('DISPUTE_OPENED');
    expect(
      type('checkout.session.completed', {
        id: 'cs_1',
        mode: 'subscription',
        subscription: 'sub_1',
        metadata: { organizationId: 'org_1', etg_purpose: 'etg_billing_subscription' },
      }),
    ).toBe('CHECKOUT_COMPLETED');
    expect(
      type(
        'checkout.session.completed',
        stripeCreditPackSession({
          id: 'cs_2',
          customer: 'cus_1',
          organizationId: 'org_1',
          packCode: 'EMAIL_5K',
          amount: 900,
          currency: 'USD',
        }),
      ),
    ).toBe('CREDIT_PACK_PAID');
    // A TICKET checkout (no billing mark) and a one-off invoice are never billing events.
    expect(type('checkout.session.completed', { id: 'cs_3', mode: 'payment', metadata: {} })).toBe(
      'IGNORED',
    );
    expect(type('invoice.paid', { id: 'in_2', parent: null })).toBe('IGNORED');
    expect(type('payment_intent.succeeded', { id: 'pi_1' })).toBe('IGNORED');
  });
});

describe('Stripe Billing: the provider records billing believes', () => {
  it('reads a paid invoice: amount before tax, tax separately, price ref and period', async () => {
    const { p, state } = stripe();
    state.invoices.in_1 = stripeInvoice({
      id: 'in_1',
      customer: 'cus_1',
      subscription: 'sub_1',
      organizationId: 'org_1',
      price: 'price_pro_m',
      amount: 2900,
      currency: 'USD',
      start,
      end,
      tax: 232,
    });
    const rec = await p.fetchPaymentRecord('in_1');
    expect(rec).toMatchObject({
      verified: true,
      amountMinor: 2900,
      taxMinor: 232,
      currency: 'USD',
      subscriptionRef: 'sub_1',
      customerRef: 'cus_1',
      providerPriceRef: 'price_pro_m',
      organizationId: 'org_1',
      purpose: 'SUBSCRIPTION',
    });
    expect(rec.periodEnd?.toISOString()).toBe(end.toISOString());
  });

  it('an open (unpaid) invoice is not verified', async () => {
    const { p, state } = stripe();
    state.invoices.in_open = stripeInvoice({
      id: 'in_open',
      customer: 'cus_1',
      subscription: 'sub_1',
      organizationId: 'org_1',
      price: 'price_pro_m',
      amount: 2900,
      currency: 'USD',
      start,
      end,
      status: 'open',
    });
    expect((await p.fetchPaymentRecord('in_open')).verified).toBe(false);
  });

  it('a credit pack is verified only when the session is complete AND paid', async () => {
    const { p, state } = stripe();
    const base = {
      customer: 'cus_1',
      organizationId: 'o',
      packCode: 'EMAIL_5K',
      amount: 900,
      currency: 'USD',
    };
    state.sessions.cs_paid = stripeCreditPackSession({ id: 'cs_paid', ...base });
    state.sessions.cs_open = stripeCreditPackSession({ id: 'cs_open', ...base, paid: false });
    expect(await p.fetchPaymentRecord('cs_paid')).toMatchObject({
      verified: true,
      purpose: 'CREDIT_PACK',
      creditPackCode: 'EMAIL_5K',
      amountMinor: 900,
    });
    expect((await p.fetchPaymentRecord('cs_open')).verified).toBe(false);
  });

  it('subscription checkout uses the mode price ref and carries the org in metadata, no promo codes', async () => {
    const { p, state } = stripe();
    const s = await p.createCheckout({
      organizationId: 'org_1',
      accountId: 'acc_1',
      priceId: 'bp_1',
      country: 'US',
      currency: 'USD',
      amountMinor: 2900,
      interval: 'MONTH',
      providerPriceRef: 'price_pro_m',
      customerRef: 'cus_1',
      successUrl: 'https://o.test/organizer/billing?checkout=success',
      cancelUrl: 'https://o.test/organizer/billing?checkout=cancelled',
    });
    expect(s.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const [params] = state.calls.find((c) => c.method === 'checkout.sessions.create')!.args as [
      Record<string, unknown>,
    ];
    expect(params).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      line_items: [{ price: 'price_pro_m', quantity: 1 }],
      allow_promotion_codes: false,
      subscription_data: { metadata: { organizationId: 'org_1', priceId: 'bp_1' } },
    });
  });

  it('refuses a checkout for a price that is not set up on Stripe', async () => {
    const { p } = stripe();
    await expect(
      p.createCheckout({
        organizationId: 'o',
        accountId: 'a',
        priceId: 'bp',
        country: 'US',
        currency: 'USD',
        amountMinor: 1,
        interval: 'MONTH',
        providerPriceRef: null,
        customerRef: 'cus',
        successUrl: 'x',
        cancelUrl: 'y',
      }),
    ).rejects.toMatchObject({ code: 'BILLING_PROVIDER_UNAVAILABLE' });
  });

  it('a provider outage is a 502 (transient), never the provider message', async () => {
    const { p, state } = stripe();
    state.failReads = Object.assign(new Error('socket hang up sk_test_secret'), {
      type: 'StripeConnectionError',
    });
    const err = await p.fetchSubscription('sub_1').catch((e) => e);
    expect(err.getStatus()).toBe(502);
    expect(err.message).not.toContain('sk_test_secret');
  });
});

describe('Razorpay Subscriptions: webhook signatures', () => {
  const sub = razorpaySubscription({
    id: 'sub_R1',
    customer: 'cust_1',
    plan: 'plan_pro_m',
    organizationId: 'org_1',
    start,
    end,
  });

  it('accepts a correctly signed event and maps subscription.charged to a payment claim', async () => {
    const { p } = razorpay();
    const body = razorpayEvent('subscription.charged', {
      subscription: sub,
      payment: { id: 'pay_1' },
    });
    const { raw, headers } = signRazorpay(body, 'evt_rzp_1');
    const ev = await p.verifyWebhook(raw, headers);
    expect(ev).toMatchObject({
      provider: 'RAZORPAY_BILLING',
      providerEventId: 'evt_rzp_1',
      type: 'PAYMENT_CAPTURED',
      paymentRef: 'pay_1',
      providerSubscriptionRef: 'sub_R1',
      organizationId: 'org_1',
    });
  });

  it('refuses a tampered body, a wrong secret and a missing signature', async () => {
    const { p } = razorpay();
    const body = razorpayEvent('subscription.charged', {
      subscription: sub,
      payment: { id: 'pay_1' },
    });
    const { raw, headers } = signRazorpay(body, 'evt_rzp_1');
    await expect(p.verifyWebhook(raw.replace('pay_1', 'pay_2'), headers)).rejects.toMatchObject({
      code: 'BILLING_WEBHOOK_INVALID',
    });
    const other = signRazorpay(body, 'evt_rzp_1', 'not-the-secret');
    await expect(p.verifyWebhook(other.raw, other.headers)).rejects.toMatchObject({
      code: 'BILLING_WEBHOOK_INVALID',
    });
    await expect(p.verifyWebhook(raw, {})).rejects.toMatchObject({
      code: 'BILLING_WEBHOOK_INVALID',
    });
  });

  it('without an event-id header the id is the payload hash, so a replay has the same id', async () => {
    const { p } = razorpay();
    const body = razorpayEvent('subscription.halted', { subscription: sub });
    const { raw, headers } = signRazorpay(body, '');
    const a = await p.verifyWebhook(raw, {
      'x-razorpay-signature': headers['x-razorpay-signature'],
    });
    const b = await p.verifyWebhook(raw, {
      'x-razorpay-signature': headers['x-razorpay-signature'],
    });
    expect(a.providerEventId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.providerEventId).toBe(b.providerEventId);
  });

  it('maps every subscribed event, and ignores subscriptions and payments that are not billing', () => {
    const { p } = razorpay();
    const t = (event: string, entities: Record<string, Record<string, unknown>>) =>
      p.parseEvent(razorpayEvent(event, entities), 'id').type;
    expect(t('subscription.authenticated', { subscription: sub })).toBe('SUBSCRIPTION_UPDATED');
    expect(t('subscription.activated', { subscription: sub })).toBe('SUBSCRIPTION_UPDATED');
    expect(t('subscription.pending', { subscription: sub })).toBe('PAYMENT_FAILED');
    expect(t('subscription.halted', { subscription: sub })).toBe('SUBSCRIPTION_HALTED');
    expect(t('subscription.cancelled', { subscription: sub })).toBe('SUBSCRIPTION_CANCELLED');
    expect(t('subscription.completed', { subscription: sub })).toBe('SUBSCRIPTION_CANCELLED');
    expect(t('payment.failed', { payment: { id: 'pay_1', invoice_id: 'inv_1' } })).toBe(
      'PAYMENT_FAILED',
    );
    // A ticket payment (no invoice) and a subscription without the billing mark are ignored.
    expect(t('payment.failed', { payment: { id: 'pay_t', order_id: 'order_1' } })).toBe('IGNORED');
    expect(
      t('subscription.charged', { subscription: { ...sub, notes: {} }, payment: { id: 'p' } }),
    ).toBe('IGNORED');
    expect(t('payment.captured', { payment: { id: 'pay_t' } })).toBe('IGNORED');
  });
});

describe('Razorpay Subscriptions: checkout guards (RBI e-mandate, plan match, capability)', () => {
  const req = {
    organizationId: 'org_1',
    accountId: 'acc_1',
    priceId: 'bp_1',
    country: 'IN',
    currency: 'INR',
    amountMinor: 99_900,
    interval: 'MONTH' as const,
    providerPriceRef: 'plan_pro_m',
    customerRef: 'cust_1',
  };

  it('creates a subscription on a plan that matches the price and returns the hosted short_url', async () => {
    const { p, state } = razorpay();
    state.plans.plan_pro_m = {
      id: 'plan_pro_m',
      period: 'monthly',
      interval: 1,
      item: { amount: 99_900, currency: 'INR' },
    };
    const s = await p.createCheckout(req);
    expect(s.url).toMatch(/^https:\/\/rzp\.test\/i\//);
    const [params] = state.calls.find((c) => c.method === 'subscriptions.create')!.args as [
      Record<string, unknown>,
    ];
    expect(params).toMatchObject({
      plan_id: 'plan_pro_m',
      notes: { organizationId: 'org_1', etg_purpose: 'etg_billing_subscription' },
    });
    // Razorpay makes its own customer at mandate authentication; we send none.
    expect(params).not.toHaveProperty('customer_id');
  });

  it('refuses a price above the e-mandate limit before asking Razorpay', async () => {
    const { p, state } = razorpay(razorpayState(), 50_000);
    await expect(p.createCheckout(req)).rejects.toMatchObject({
      code: 'BILLING_PROVIDER_UNAVAILABLE',
    });
    expect(state.calls).toEqual([]);
  });

  it('refuses when the Razorpay plan charges something else than the price', async () => {
    const { p, state } = razorpay();
    state.plans.plan_pro_m = {
      id: 'plan_pro_m',
      period: 'monthly',
      interval: 1,
      item: { amount: 49_900, currency: 'INR' },
    };
    await expect(p.createCheckout(req)).rejects.toMatchObject({
      code: 'BILLING_PROVIDER_UNAVAILABLE',
    });
  });

  it('says plainly when Subscriptions is not enabled on the Razorpay account', async () => {
    const { p, state } = razorpay();
    state.plans.plan_pro_m = {
      id: 'plan_pro_m',
      period: 'monthly',
      interval: 1,
      item: { amount: 99_900, currency: 'INR' },
    };
    state.failCreate = {
      statusCode: 400,
      error: { description: 'Subscriptions feature is not enabled for this merchant' },
    };
    const err = await p.createCheckout(req).catch((e) => e);
    expect(err.code).toBe('BILLING_PROVIDER_UNAVAILABLE');
    expect(err.message).toMatch(/Razorpay Subscriptions/);
    expect(err.getStatus()).toBe(409);
  });
});

describe('billing credentials and provider routing', () => {
  it('reads key modes from prefixes and refuses live keys outside STAGING/PRODUCTION', () => {
    expect(keyModeOf('sk_test_abc', 'stripe')).toBe('test');
    expect(keyModeOf('rk_live_abc', 'stripe')).toBe('live');
    expect(keyModeOf('rzp_test_abc', 'razorpay')).toBe('test');
    expect(() => assertUsableKey('K', 'sk_live_abc', 'stripe', 'QA')).toThrow(/LIVE key/);
    expect(() => assertUsableKey('K', 'rzp_live_abc', 'razorpay', 'LOCAL')).toThrow(/LIVE key/);
    expect(() => assertUsableKey('K', 'nonsense', 'stripe', 'QA')).toThrow(/unexpected prefix/);
    // The message names the variable, never the value.
    expect(() =>
      assertUsableKey('STRIPE_BILLING_SECRET_KEY', 'sk_live_Zq9VALUE', 'stripe', 'QA'),
    ).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('Zq9VALUE') as never }),
    );
  });

  it('a _REF goes through the secret manager; the webhook secret never falls back', async () => {
    const cfg = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
    const secrets = { getSecret: jest.fn(async () => 'whsec_from_manager') };
    expect(
      await resolveCredential(
        cfg({ STRIPE_BILLING_WEBHOOK_SECRET_REF: 'billing/stripe/test/webhook-secret' }),
        secrets,
        { name: 'STRIPE_BILLING_WEBHOOK_SECRET' },
      ),
    ).toBe('whsec_from_manager');
    expect(secrets.getSecret).toHaveBeenCalledWith('billing/stripe/test/webhook-secret');
    expect(
      await resolveCredential(cfg({ STRIPE_SECRET_KEY: 'sk_test_ticket' }), null, {
        name: 'STRIPE_BILLING_SECRET_KEY',
        fallback: 'STRIPE_SECRET_KEY',
      }),
    ).toBe('sk_test_ticket');
    expect(
      await resolveCredential(cfg({ STRIPE_WEBHOOK_SECRET: 'whsec_ticket' }), null, {
        name: 'STRIPE_BILLING_WEBHOOK_SECRET',
      }),
    ).toBeNull();
  });

  it('routes US to Stripe and IN to Razorpay; other countries get the disabled provider', async () => {
    const env: Record<string, string> = {
      APP_ENV: 'QA',
      BILLING_PROVIDER: 'providers',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_x',
      RAZORPAY_KEY_ID: 'rzp_test_x',
      RAZORPAY_KEY_SECRET: 's',
      RAZORPAY_BILLING_WEBHOOK_SECRET: 'w',
    };
    const r = new BillingProviderRegistry(
      { get: (k: string) => env[k] } as never,
      new DisabledBillingProvider(),
      null,
    );
    expect((await r.forCountry('US')).key).toBe('STRIPE_BILLING');
    expect((await r.forCountry('IN')).key).toBe('RAZORPAY_BILLING');
    expect((await r.forCountry('CA')).key).toBe('NONE');
    expect(r.configuredFor('US')).toBe(true);
    expect(r.configuredFor('CA')).toBe(false);
  });

  it('refuses to build a provider from a live key, and does not cache the failure', async () => {
    const env: Record<string, string> = {
      APP_ENV: 'QA',
      BILLING_PROVIDER: 'providers',
      STRIPE_SECRET_KEY: 'sk_live_x',
      STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_x',
    };
    const r = new BillingProviderRegistry(
      { get: (k: string) => env[k] } as never,
      new DisabledBillingProvider(),
      null,
    );
    await expect(r.forCountry('US')).rejects.toMatchObject({
      code: 'BILLING_PROVIDER_UNAVAILABLE',
    });
    env.STRIPE_SECRET_KEY = 'sk_test_x';
    expect((await r.forCountry('US')).key).toBe('STRIPE_BILLING');
  });

  it('in mock mode every country gets the test double', async () => {
    const mock = new MockBillingProvider();
    const r = new BillingProviderRegistry(
      { get: (k: string) => ({ BILLING_PROVIDER: 'mock' })[k] } as never,
      mock,
      null,
    );
    expect(await r.forCountry('US')).toBe(mock);
    expect(await r.forCountry('IN')).toBe(mock);
  });
});

describe('production live markets (BILLING_LIVE_MARKETS)', () => {
  const prodEnv = (markets: string): Record<string, string> => ({
    APP_ENV: 'PRODUCTION',
    BILLING_ENABLED: 'true',
    BILLING_PROVIDER: 'providers',
    BILLING_LIVE_ENABLED: 'true',
    BILLING_LIVE_MARKETS: markets,
    STRIPE_BILLING_SECRET_KEY: 'sk_live_x',
    STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_x',
    // The ticket Razorpay account is configured, but IN is not a listed billing market.
    RAZORPAY_KEY_ID: 'rzp_live_ticket',
    RAZORPAY_KEY_SECRET: 's',
    RAZORPAY_BILLING_WEBHOOK_SECRET: 'w',
  });
  const registry = (env: Record<string, string>) =>
    new BillingProviderRegistry(
      { get: (k: string) => env[k] } as never,
      new DisabledBillingProvider(),
      null,
    );

  it('a listed market keeps its route (US to Stripe); an unlisted one gets nothing', async () => {
    const r = registry(prodEnv('US'));
    expect(r.liveMarketOpen('US')).toBe(true);
    expect(r.liveMarketOpen('IN')).toBe(false);
    expect(r.configuredFor('US')).toBe(true);
    expect(r.configuredFor('IN')).toBe(false);
    expect((await r.forCountry('US')).key).toBe('STRIPE_BILLING');
    expect((await r.forCountry('IN')).key).toBe('NONE');
  });

  it('the master switch off closes every market', () => {
    const r = registry({ ...prodEnv('US,IN'), BILLING_LIVE_ENABLED: 'false' });
    expect(r.liveMarketOpen('US')).toBe(false);
    expect(r.configuredFor('US')).toBe(false);
  });

  it('PRODUCTION never falls back to the ticket keys', () => {
    const env = prodEnv('US,IN');
    delete env.STRIPE_BILLING_SECRET_KEY;
    env.STRIPE_SECRET_KEY = 'sk_live_ticket';
    const r = registry(env);
    expect(r.configuredFor('US')).toBe(false);
    expect(r.configuredFor('IN')).toBe(false);
  });

  it('outside PRODUCTION the markets list plays no part (QA unchanged)', () => {
    const r = registry({
      APP_ENV: 'QA',
      BILLING_PROVIDER: 'providers',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_BILLING_WEBHOOK_SECRET: 'whsec_x',
    });
    expect(r.liveMarketOpen('US')).toBe(true);
    expect(r.configuredFor('US')).toBe(true);
  });

  it('checkout refuses an unlisted market with a clear error', () => {
    const env = prodEnv('US');
    const svc = new BillingCheckoutService(
      null as never,
      { get: (k: string) => env[k] } as never,
      registry(env),
      null as never,
      null as never,
      null as never,
    );
    const assertEnabled = (c: string) =>
      (svc as unknown as { assertEnabled(c: string): void }).assertEnabled(c);
    expect(() => assertEnabled('US')).not.toThrow();
    let err: { code?: string; message?: string } = {};
    try {
      assertEnabled('IN');
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.code).toBe('BILLING_NOT_ENABLED');
    expect(err.message).toMatch(/not open in your country yet/);
  });
});
