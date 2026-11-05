import { billingConfigurationErrors } from '../config/configuration';
import { BillingCatalogService } from './billing-catalog.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingPriceReconcileService, stripeLookupKey } from './billing-price-reconcile.service';
import { BillingProviderEventService } from './billing-provider-events.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import { DisabledBillingProvider } from './provider/billing-provider';
import type { ProviderPriceRecord } from './provider/billing-provider';
import {
  STRIPE_PURPOSE_CREDIT_PACK,
  STRIPE_PURPOSE_SUBSCRIPTION,
  StripeBillingProvider,
} from './provider/stripe-billing.provider';
import { signStripe, stripeEvent } from './provider/billing-provider.fixture';

/**
 * PRODUCTION with the live billing master switch and the US market configured, but
 * BILLING_ENABLED off: the state the US catalogue is prepared in before sales open.
 *
 * Proves that this state boots, that no checkout reaches Stripe, that loading the catalogue
 * and linking its live Stripe prices do not open sales, and that a validly signed live
 * webhook cannot create a subscription, credits or an entitlement.
 */
const WEBHOOK_SECRET = 'whsec_live_gate_safety';
const PROD_LIVE_US = {
  APP_ENV: 'PRODUCTION',
  BILLING_PROVIDER: 'providers',
  BILLING_LIVE_ENABLED: 'true',
  BILLING_LIVE_MARKETS: 'US',
  STRIPE_BILLING_SECRET_KEY: 'sk_live_x',
  STRIPE_BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET,
};
const ENABLED_VARIANTS: Array<[string, Record<string, string>]> = [
  ['BILLING_ENABLED unset', {}],
  ['BILLING_ENABLED=false', { BILLING_ENABLED: 'false' }],
];

const config = (env: Record<string, string>) => ({ get: (k: string) => env[k] }) as never;

type Row = Record<string, unknown> & { id: string };

/** An in-memory store for just the tables these paths use. Any other table is undefined. */
function store() {
  let n = 0;
  const id = (p: string) => `${p}_${++n}`;
  const db = {
    organization: [{ id: 'org_us', name: 'US Org', legalName: null, registeredCountry: 'US' }],
    organizerBillingAccount: [] as Row[],
    billingPlan: [] as Row[],
    planEntitlement: [] as Row[],
    billingPrice: [] as Row[],
    billingWebhookEvent: [] as Row[],
  };
  const writes: string[] = [];
  const match = (row: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in v)
        return (v as { in: unknown[] }).in.includes(row[k]);
      if (v && typeof v === 'object' && 'gt' in v)
        return (row[k] as number) > (v as { gt: number }).gt;
      return row[k] === v;
    });
  const table = (name: keyof typeof db, defaults: Record<string, unknown> = {}) => ({
    findUnique: async ({ where }: { where: Record<string, unknown> }) =>
      db[name].find((r) => match(r as Row, where)) ?? null,
    findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
      const r = db[name].find((x) => match(x as Row, where));
      if (!r) throw new Error('not found');
      return r;
    },
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      (db[name] as Row[])
        .filter((r) => match(r, where))
        .map((r) =>
          name === 'billingPrice'
            ? { ...r, plan: db.billingPlan.find((p) => p.id === r.planId) }
            : r,
        ),
    count: async ({ where }: { where: Record<string, unknown> }) =>
      db[name].filter((r) => match(r as Row, where)).length,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(`${name}.create`);
      const row = { id: id(name), ...defaults, ...data } as Row;
      (db[name] as Row[]).push(row);
      return row;
    },
    upsert: async (a: { where: Record<string, unknown>; create: Record<string, unknown> }) => {
      writes.push(`${name}.upsert`);
      const found = db[name].find((r) => match(r as Row, a.where));
      if (found) return found;
      const row = { id: id(name), ...defaults, ...a.create } as Row;
      (db[name] as Row[]).push(row);
      return row;
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      writes.push(`${name}.update:${Object.keys(data).sort().join(',')}`);
      const r = db[name].find((x) => match(x as Row, where)) as Row;
      Object.assign(r, data);
      return r;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      writes.push(`${name}.updateMany:${Object.keys(data).sort().join(',')}`);
      const rows = db[name].filter((x) => match(x as Row, where)) as Row[];
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
  });
  const prisma = {
    organization: table('organization'),
    organizerBillingAccount: table('organizerBillingAccount', {
      provider: 'NONE',
      providerCustomerRef: null,
      billingEmail: null,
    }),
    billingPlan: table('billingPlan', { active: true }),
    planEntitlement: table('planEntitlement'),
    billingPrice: table('billingPrice', {
      active: true,
      providerPriceRefTest: null,
      providerPriceRefLive: null,
    }),
    billingWebhookEvent: table('billingWebhookEvent', { status: 'RECEIVED', attempts: 0 }),
    organizerSubscription: { findUnique: async () => null },
    creditPackPurchase: {},
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
  return { db, prisma, writes };
}

const audit = { recordInTransaction: async () => undefined, afterCommit: () => undefined };

/** Every Stripe call that could create or change something live. None may run. */
function spyStripe() {
  const p = StripeBillingProvider.prototype;
  return {
    ensureCustomer: jest.spyOn(p, 'ensureCustomer'),
    createCheckout: jest.spyOn(p, 'createCheckout'),
    createCreditPackCheckout: jest.spyOn(p, 'createCreditPackCheckout'),
    createPortal: jest.spyOn(p, 'createPortal'),
    cancelAtPeriodEnd: jest.spyOn(p, 'cancelAtPeriodEnd'),
  };
}

function harness(extra: Record<string, string>) {
  const env = { ...PROD_LIVE_US, ...extra };
  const s = store();
  const registry = new BillingProviderRegistry(config(env), new DisabledBillingProvider(), null);
  const tax = { quote: jest.fn() };
  const packPrices = { publishedPrice: jest.fn() };
  const checkout = new BillingCheckoutService(
    s.prisma as never,
    config(env),
    registry,
    {} as never,
    tax as never,
    packPrices as never,
  );
  const catalog = new BillingCatalogService(s.prisma as never, audit as never);
  const reconcile = new BillingPriceReconcileService(
    s.prisma as never,
    config(env),
    registry,
    audit as never,
  );
  return { ...s, env, registry, checkout, catalog, reconcile, tax, packPrices };
}

afterEach(() => jest.restoreAllMocks());

describe.each(ENABLED_VARIANTS)('PRODUCTION, live US configured, %s', (_label, extra) => {
  it('(a) boots: the billing configuration has no errors', () => {
    // Unset reaches this check as undefined here; the schema defaults it to "false".
    expect(billingConfigurationErrors({ ...PROD_LIVE_US, ...extra } as never)).toEqual([]);
  });

  async function expectNoSale(h: ReturnType<typeof harness>, stripe: ReturnType<typeof spyStripe>) {
    await expect(h.checkout.startPlanCheckout('org_us', 'any_price')).rejects.toMatchObject({
      code: 'BILLING_NOT_ENABLED',
    });
    await expect(h.checkout.startCreditPackCheckout('org_us', 'EMAIL_1000')).rejects.toMatchObject({
      code: 'BILLING_NOT_ENABLED',
    });
    for (const spy of Object.values(stripe)) expect(spy).not.toHaveBeenCalled();
    expect(h.tax.quote).not.toHaveBeenCalled();
    expect(h.packPrices.publishedPrice).not.toHaveBeenCalled();
    // The account row may exist; it is never bound to a provider or a customer.
    for (const a of h.db.organizerBillingAccount) {
      expect(a).toMatchObject({ provider: 'NONE', providerCustomerRef: null });
    }
  }

  it('(b) plan and credit-pack checkout are refused and call no provider method', async () => {
    const stripe = spyStripe();
    await expectNoSale(harness(extra), stripe);
  });

  it('(c)+(d) loading the catalogue and linking live refs open no sale and change only refs', async () => {
    const stripe = spyStripe();
    const h = harness(extra);
    await h.catalog.loadProvisional('admin_1');
    const usPaid = h.db.billingPrice.filter((p) => p.country === 'US' && p.amountMinor !== 0);
    expect(usPaid).toHaveLength(4);

    const lookup = jest
      .spyOn(StripeBillingProvider.prototype, 'findPriceByLookupKey')
      .mockImplementation(async (key: string): Promise<ProviderPriceRecord> => {
        const p = usPaid.find(
          (x) =>
            stripeLookupKey(
              h.db.billingPlan.find((pl) => pl.id === x.planId)!.code as string,
              x.currency as string,
              x.interval as string,
            ) === key,
        )!;
        return {
          ref: `price_live_${key}`,
          found: true,
          amountMinor: p.amountMinor as number,
          currency: p.currency as string,
          interval: p.interval as 'MONTH' | 'YEAR',
          intervalCount: 1,
          active: true,
          taxBehavior: 'exclusive',
        };
      });

    const before = JSON.parse(JSON.stringify(h.db));
    const writesBefore = h.writes.length;
    const report = await h.reconcile.syncProviderRefs({
      mode: 'live',
      dryRun: false,
      actorUserId: 'admin_1',
    });
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(report.written).toHaveLength(4);

    // (d) The only writes are providerPriceRefLive on those four prices.
    expect(h.writes.slice(writesBefore)).toEqual(
      Array(4).fill('billingPrice.updateMany:providerPriceRefLive'),
    );
    const after = JSON.parse(JSON.stringify(h.db));
    for (const p of after.billingPrice) {
      const was = before.billingPrice.find((b: Row) => b.id === p.id);
      expect({ ...p, providerPriceRefLive: was.providerPriceRefLive }).toEqual(was);
    }
    expect(after.billingPlan).toEqual(before.billingPlan);
    expect(after.planEntitlement).toEqual(before.planEntitlement);
    expect(after.organizerBillingAccount).toEqual(before.organizerBillingAccount);
    expect(usPaid.every((p) => typeof p.providerPriceRefLive === 'string')).toBe(true);

    // (c) Still no sale, now that every US price has a live Stripe price.
    await expect(h.checkout.startPlanCheckout('org_us', usPaid[0].id)).rejects.toMatchObject({
      code: 'BILLING_NOT_ENABLED',
    });
    await expectNoSale(h, stripe);
  });

  it('a validly signed live webhook creates no subscription, credits or entitlement', async () => {
    const h = harness(extra);
    jest.spyOn(StripeBillingProvider.prototype, 'fetchSubscription').mockResolvedValue({
      verified: true,
      status: 'ACTIVE',
      latestPaidPaymentRef: 'in_live_1',
      customerRef: 'cus_made_outside',
    } as never);
    // Stripe's own (verified) records say each payment really happened.
    jest
      .spyOn(StripeBillingProvider.prototype, 'fetchPaymentRecord')
      .mockImplementation(async (ref: string) =>
        ref === 'cs_2'
          ? ({
              verified: true,
              purpose: 'CREDIT_PACK',
              paymentRef: 'cs_2',
              customerRef: 'cus_made_outside',
              organizationId: 'org_us',
              creditPackCode: 'EMAIL_1K',
              purchaseRef: 'pk_unknown',
              amountMinor: 900,
              currency: 'USD',
            } as never)
          : ({
              verified: true,
              purpose: 'SUBSCRIPTION',
              paymentRef: 'in_live_1',
              customerRef: 'cus_made_outside',
              subscriptionRef: 'sub_live_1',
              organizationId: 'org_us',
              amountMinor: 1900,
              currency: 'USD',
            } as never),
      );
    const tripwire = () => {
      throw new Error('must not be reached');
    };
    const service = new BillingProviderEventService(
      h.prisma as never,
      audit as never,
      { applyInTx: tripwire } as never,
      { bust: tripwire } as never,
      { runWithEvents: tripwire } as never,
      {} as never,
      h.registry,
      config(h.env),
    );
    const controller = new BillingWebhookController(h.registry, service);
    const deliver = (ev: Record<string, unknown>) => {
      const { raw, headers } = signStripe(ev, WEBHOOK_SECRET);
      return controller.stripe({
        rawBody: Buffer.from(raw),
        header: (n: string) => (headers as Record<string, string>)[n],
      } as never);
    };

    const sub = await deliver(
      stripeEvent('evt_1', 'checkout.session.completed', {
        id: 'cs_1',
        mode: 'subscription',
        subscription: 'sub_live_1',
        metadata: { etg_purpose: STRIPE_PURPOSE_SUBSCRIPTION, organizationId: 'org_us' },
      }),
    );
    const paid = await deliver(
      stripeEvent('evt_2', 'invoice.paid', {
        id: 'in_live_1',
        parent: {
          subscription_details: {
            subscription: 'sub_live_1',
            metadata: { organizationId: 'org_us' },
          },
        },
      }),
    );
    const pack = await deliver(
      stripeEvent('evt_3', 'checkout.session.completed', {
        id: 'cs_2',
        mode: 'payment',
        metadata: { etg_purpose: STRIPE_PURPOSE_CREDIT_PACK, organizationId: 'org_us' },
      }),
    );
    for (const r of [sub, paid, pack]) expect(r.received).toBe(true);
    for (const r of [sub, paid, pack]) expect(r).toMatchObject({ outcome: 'FAILED' });
    // Refused because no account is bound to Stripe: only a checkout (behind
    // BILLING_ENABLED) binds one. Recorded for staff, nothing applied.
    expect(h.db.billingWebhookEvent.map((e) => [e.status, e.error])).toEqual([
      ['FAILED', expect.stringMatching(/no billing account/)],
      ['FAILED', expect.stringMatching(/no billing account/)],
      ['FAILED', expect.stringMatching(/no billing account/)],
    ]);
    expect(h.db.organizerBillingAccount).toEqual([]);
  });
});

describe('control: the same harness with BILLING_ENABLED=true does reach Stripe', () => {
  it('so the refusals above come from BILLING_ENABLED, not from a broken harness', async () => {
    const stripe = spyStripe();
    stripe.ensureCustomer.mockResolvedValue('cus_1');
    stripe.createCheckout.mockResolvedValue({
      url: 'https://checkout',
      sessionRef: 'cs_x',
    } as never);
    const h = harness({
      BILLING_ENABLED: 'true',
      ORGANIZER_WEB_URL: 'https://organizer.example.test',
    });
    expect(billingConfigurationErrors(h.env as never)).toEqual([]);
    await h.catalog.loadProvisional('admin_1');
    const price = h.db.billingPrice.find((p) => p.country === 'US' && p.amountMinor === 1900)!;
    price.providerPriceRefLive = 'price_live_pro';
    h.tax.quote.mockResolvedValue({ mode: 'STRIPE_TAX', netMinor: 1900, taxMinor: 0 });
    await h.checkout.startPlanCheckout('org_us', price.id);
    expect(stripe.ensureCustomer).toHaveBeenCalledTimes(1);
    expect(stripe.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ providerPriceRef: 'price_live_pro' }),
    );
  });
});
