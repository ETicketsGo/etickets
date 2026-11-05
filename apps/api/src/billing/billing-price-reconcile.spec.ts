import { NotificationType } from '@eticketsgo/shared-types';
import { dedupeKeyFor } from '../notifications/policy/dedupe-key';
import { dunningLink, sendDunning } from './billing-dunning';
import { BillingPriceReconcileService, mismatchFields } from './billing-price-reconcile.service';
import { StripeBillingProvider } from './provider/stripe-billing.provider';
import type { ProviderPriceRecord } from './provider/billing-provider';

const good = (over: Partial<ProviderPriceRecord> = {}): ProviderPriceRecord => ({
  ref: 'price_pro_m',
  found: true,
  amountMinor: 1900,
  currency: 'USD',
  interval: 'MONTH',
  intervalCount: 1,
  active: true,
  taxBehavior: 'exclusive',
  ...over,
});
const local = { amountMinor: 1900, currency: 'USD', interval: 'MONTH', active: true };

describe('plan price check against Stripe (the admin catalogue is authoritative)', () => {
  it('names each field that differs', () => {
    expect(mismatchFields(local, good())).toEqual([]);
    expect(mismatchFields(local, good({ found: false }))).toEqual(['missing']);
    expect(mismatchFields(local, good({ amountMinor: 2900 }))).toEqual(['amount']);
    expect(mismatchFields(local, good({ currency: 'CAD' }))).toEqual(['currency']);
    expect(mismatchFields(local, good({ interval: 'YEAR' }))).toEqual(['interval']);
    expect(mismatchFields(local, good({ intervalCount: 3 }))).toEqual(['interval']);
    expect(mismatchFields(local, good({ active: false }))).toEqual(['active']);
    expect(mismatchFields(local, good({ taxBehavior: 'unspecified' }))).toEqual(['tax_behavior']);
    expect(mismatchFields(local, good({ taxBehavior: 'inclusive', amountMinor: 1 }))).toEqual([
      'amount',
      'tax_behavior',
    ]);
  });

  function harness(opts: {
    env?: Record<string, string>;
    stripe: Record<string, ProviderPriceRecord | Error>;
    mode?: 'test' | 'live';
  }) {
    const env = { BILLING_ENABLED: 'true', ...(opts.env ?? {}) };
    const rows = [
      {
        id: 'bp_pro_m',
        country: 'US',
        currency: 'USD',
        interval: 'MONTH',
        amountMinor: 1900,
        active: true,
        providerPriceRefTest: 'price_pro_m',
        providerPriceRefLive: null,
        plan: { code: 'PRO' },
      },
      {
        id: 'bp_prem_m',
        country: 'US',
        currency: 'USD',
        interval: 'MONTH',
        amountMinor: 4900,
        active: true,
        providerPriceRefTest: 'price_prem_m',
        providerPriceRefLive: null,
        plan: { code: 'PREMIUM' },
      },
    ];
    const findManyArgs: unknown[] = [];
    // No update/create/upsert: the check must not be able to write a price.
    const prisma = {
      billingPrice: {
        findMany: async (args: { distinct?: string[] }) => {
          findManyArgs.push(args);
          return args.distinct ? [{ country: 'US' }, { country: 'IN' }] : rows;
        },
      },
    };
    const fetched: string[] = [];
    const provider = {
      key: 'STRIPE_BILLING',
      mode: opts.mode ?? 'test',
      fetchPrice: async (ref: string) => {
        fetched.push(ref);
        const r = opts.stripe[ref];
        if (r instanceof Error) throw r;
        return r ?? good({ ref, found: false });
      },
    };
    const registry = {
      keyForCountry: (c: string) => (c === 'US' ? 'STRIPE_BILLING' : 'RAZORPAY_BILLING'),
      configuredFor: (c: string) => c === 'US',
      byKey: async () => provider,
    };
    const audits: Record<string, unknown>[] = [];
    const audit = { record: async (e: Record<string, unknown>) => void audits.push(e) };
    const alerts: Record<string, unknown>[] = [];
    const ops = { notify: async (a: Record<string, unknown>) => (alerts.push(a), {}) };
    const svc = new BillingPriceReconcileService(
      prisma as never,
      { get: (k: string) => env[k as keyof typeof env] } as never,
      registry as never,
      audit as never,
      ops as never,
    );
    return { svc, audits, alerts, fetched, findManyArgs };
  }

  it('reports a Stripe-side change, audits and alerts it, and changes nothing', async () => {
    const h = harness({
      stripe: {
        price_pro_m: good({ amountMinor: 2500 }),
        price_prem_m: good({ ref: 'price_prem_m', amountMinor: 4900, active: false }),
      },
    });
    const r = await h.svc.run({ record: true });
    expect(r).toMatchObject({ skipped: null, mode: 'test', checked: 2 });
    expect(r.mismatches.map((m) => [m.priceId, m.fields])).toEqual([
      ['bp_pro_m', ['amount']],
      ['bp_prem_m', ['active']],
    ]);
    expect(r.mismatches[0]).toMatchObject({
      local: { amountMinor: 1900 },
      provider: { amountMinor: 2500 },
    });
    expect(h.audits.map((a) => [a.action, a.entityId])).toEqual([
      ['BILLING_PRICE_PROVIDER_MISMATCH', 'bp_pro_m'],
      ['BILLING_PRICE_PROVIDER_MISMATCH', 'bp_prem_m'],
    ]);
    expect(h.audits[0].metadata).toMatchObject({ applied: false, fields: ['amount'] });
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ kind: 'BILLING_PRICE_MISMATCH', key: 'test' });
    // Only Stripe-routed countries, and only the refs of the key mode in use.
    const query = h.findManyArgs[1] as { where: Record<string, unknown> };
    expect(query.where).toEqual({
      country: { in: ['US'] },
      providerPriceRefTest: { not: null },
    });
  });

  it('as a read (the admin endpoint) it records nothing', async () => {
    const h = harness({ stripe: { price_pro_m: good({ found: false }) } });
    const r = await h.svc.run({ record: false });
    expect(r.mismatches.map((m) => m.fields)).toEqual([['missing'], ['missing']]);
    expect(r.mismatches[0].provider).toBeNull();
    expect(h.audits).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it('all matching: nothing recorded; an unreachable provider is not a mismatch', async () => {
    const h = harness({
      stripe: {
        price_pro_m: good(),
        price_prem_m: Object.assign(new Error('down'), { type: 'StripeConnectionError' }),
      },
    });
    const r = await h.svc.run({ record: true });
    expect(r).toMatchObject({ checked: 1, unreachable: ['price_prem_m'], mismatches: [] });
    expect(h.audits).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it('live keys check live refs; billing off checks nothing', async () => {
    const live = harness({ mode: 'live', stripe: {} });
    await live.svc.run({ record: false });
    expect((live.findManyArgs[1] as { where: Record<string, unknown> }).where).toEqual({
      country: { in: ['US'] },
      providerPriceRefLive: { not: null },
    });
    const off = harness({ env: { BILLING_ENABLED: 'false' }, stripe: {} });
    expect(await off.svc.run({ record: true })).toMatchObject({ checked: 0 });
    expect((await off.svc.run({ record: true })).skipped).toMatch(/off/);
    expect(off.fetched).toEqual([]);
  });
});

describe('StripeBillingProvider.fetchPrice', () => {
  const provider = (retrieve: (id: string) => Promise<unknown>) =>
    new StripeBillingProvider({
      secretKey: 'sk_test_x',
      webhookSecret: 'whsec_x',
      mode: 'test',
      client: { prices: { retrieve } } as never,
    });

  it('maps a recurring price', async () => {
    const p = provider(async (id) => ({
      id,
      unit_amount: 1900,
      currency: 'usd',
      recurring: { interval: 'month', interval_count: 1 },
      active: true,
      tax_behavior: 'exclusive',
    }));
    expect(await p.fetchPrice('price_1')).toEqual(good({ ref: 'price_1' }));
  });

  it('a price Stripe does not have is found:false, other failures throw', async () => {
    const missing = provider(async () => {
      throw Object.assign(new Error('No such price'), { code: 'resource_missing' });
    });
    expect(await missing.fetchPrice('price_gone')).toMatchObject({ found: false });
    const down = provider(async () => {
      throw Object.assign(new Error('x'), { type: 'StripeConnectionError' });
    });
    await expect(down.fetchPrice('price_1')).rejects.toThrow(/StripeConnectionError/);
  });
});

describe('dunning reminders carry the billing link', () => {
  it('the link is the organizer billing page; null when the console origin is unknown', () => {
    const cfg = (env: Record<string, string>) => ({ get: (k: string) => env[k] }) as never;
    expect(
      dunningLink(cfg({ APP_ENV: 'QA', ORGANIZER_WEB_URL: 'https://organizer-qa.example/' })),
    ).toBe('https://organizer-qa.example/organizer/billing');
    expect(dunningLink(cfg({ APP_ENV: 'QA' }))).toBeNull();
    expect(dunningLink(null)).toBeNull();
  });

  it('sends the link in the payload, and the link does not change the dedupe key', async () => {
    const sent: Record<string, unknown>[] = [];
    const audience = {
      notifyOrganizationOwners: async (_o: string, _t: unknown, p: Record<string, unknown>) => {
        sent.push(p);
        return 1;
      },
    };
    const base = {
      organizationId: 'org_1',
      subscriptionId: 'sub_1',
      stage: 'PAST_DUE' as const,
      planName: 'Pro',
      currentPeriodEnd: new Date('2026-11-30T06:43:34Z'),
      graceEndsAt: null,
    };
    await sendDunning(audience, { ...base, link: 'https://organizer.test/organizer/billing' });
    await sendDunning(audience, base);
    expect(sent[0].link).toBe('https://organizer.test/organizer/billing');
    expect(sent[1]).not.toHaveProperty('link');
    const key = (payload: Record<string, unknown>) =>
      dedupeKeyFor({
        type: NotificationType.BILLING_PAYMENT_FAILED,
        channel: 'email',
        recipientRef: 'user_1',
        payload,
      });
    expect(key(sent[0])).toBe(key(sent[1]));
    expect(key(sent[0])).toBeTruthy();
  });
});
