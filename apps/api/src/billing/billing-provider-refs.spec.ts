import { AppException } from '../common/errors';
import { BillingPriceReconcileService, stripeLookupKey } from './billing-price-reconcile.service';
import { StripeBillingProvider } from './provider/stripe-billing.provider';
import type { ProviderPriceRecord } from './provider/billing-provider';

/*
  POST admin/billing/catalog/sync-provider-refs: point the USD catalogue at its Stripe prices by
  lookup key. Writes only empty refs of the key's own mode, all or nothing, never publishes.
*/

type Row = {
  id: string;
  country: string;
  currency: string;
  interval: 'MONTH' | 'YEAR';
  amountMinor: number;
  active: boolean;
  providerPriceRefTest: string | null;
  providerPriceRefLive: string | null;
  plan: { code: string };
};

const usd = (code: string, interval: 'MONTH' | 'YEAR', amountMinor: number): Row => ({
  id: `bp_${code}_${interval}`.toLowerCase(),
  country: 'US',
  currency: 'USD',
  interval,
  amountMinor,
  active: true,
  providerPriceRefTest: null,
  providerPriceRefLive: null,
  plan: { code },
});

/** What the owner's live Stripe account holds (checked read-only 2026-11-01). */
const STRIPE: Record<string, ProviderPriceRecord> = {
  etg_pro_usd_month: rec('price_pro_m', 1900, 'MONTH'),
  etg_pro_usd_year: rec('price_pro_y', 19000, 'YEAR'),
  etg_premium_usd_month: rec('price_prem_m', 4900, 'MONTH'),
  etg_premium_usd_year: rec('price_prem_y', 49000, 'YEAR'),
};

function rec(
  ref: string,
  amountMinor: number,
  interval: 'MONTH' | 'YEAR',
  over: Partial<ProviderPriceRecord> = {},
): ProviderPriceRecord {
  return {
    ref,
    found: true,
    amountMinor,
    currency: 'USD',
    interval,
    intervalCount: 1,
    active: true,
    taxBehavior: 'exclusive',
    ...over,
  };
}

function harness(
  opts: {
    mode?: 'live' | 'test';
    stripe?: Record<string, ProviderPriceRecord>;
    rows?: Row[];
    noLookup?: boolean;
  } = {},
) {
  const rows: Row[] = opts.rows ?? [
    usd('PRO', 'MONTH', 1900),
    usd('PRO', 'YEAR', 19000),
    usd('PREMIUM', 'MONTH', 4900),
    usd('PREMIUM', 'YEAR', 49000),
  ];
  const stripe = opts.stripe ?? STRIPE;
  const findManyArgs: Array<{ where: Record<string, unknown> }> = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];
  // Only updateMany exists: no create, no update of amount/active, no plan writes.
  const tx = {
    billingPrice: {
      updateMany: async (args: {
        where: { id: string } & Record<string, unknown>;
        data: Record<string, string>;
      }) => {
        updates.push(args);
        const row = rows.find((r) => r.id === args.where.id)!;
        const [field, value] = Object.entries(args.data)[0] as [keyof Row, string];
        if (row[field] !== null) return { count: 0 };
        (row as Record<string, unknown>)[field] = value;
        return { count: 1 };
      },
    },
  };
  const prisma = {
    billingPrice: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        findManyArgs.push(args);
        return rows.map((r) => ({ ...r }));
      },
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const looked: string[] = [];
  const provider = {
    key: 'STRIPE_BILLING',
    enabled: true,
    mode: opts.mode ?? 'live',
    ...(opts.noLookup
      ? {}
      : {
          findPriceByLookupKey: async (k: string) => {
            looked.push(k);
            return stripe[k] ?? rec('', 0, 'MONTH', { found: false });
          },
        }),
  };
  const registry = { byKey: async () => provider };
  const audit = {
    record: async () => {
      throw new Error('outside a transaction');
    },
    recordInTransaction: async (_t: unknown, e: Record<string, unknown>) => void audits.push(e),
  };
  const svc = new BillingPriceReconcileService(
    prisma as never,
    { get: () => undefined } as never,
    registry as never,
    audit as never,
    null,
  );
  const run = (over: { mode?: 'live' | 'test'; dryRun?: boolean } = {}) =>
    svc.syncProviderRefs({
      mode: over.mode ?? 'live',
      dryRun: over.dryRun ?? false,
      actorUserId: 'admin_1',
    });
  return { run, rows, updates, audits, looked, findManyArgs };
}

async function refusal(p: Promise<unknown>): Promise<AppException> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppException);
  return err as AppException;
}

describe('syncing Stripe price refs into the catalogue (by lookup key)', () => {
  it('lookup keys are etg_<plan>_<currency>_<interval>', () => {
    expect(stripeLookupKey('PRO', 'USD', 'MONTH')).toBe('etg_pro_usd_month');
    expect(stripeLookupKey('PREMIUM', 'USD', 'YEAR')).toBe('etg_premium_usd_year');
  });

  it('writes the four live refs, audited, and touches nothing else', async () => {
    const h = harness();
    const r = await h.run();
    expect(r.written.map((w) => [w.lookupKey, w.providerPriceRef])).toEqual([
      ['etg_pro_usd_month', 'price_pro_m'],
      ['etg_pro_usd_year', 'price_pro_y'],
      ['etg_premium_usd_month', 'price_prem_m'],
      ['etg_premium_usd_year', 'price_prem_y'],
    ]);
    expect(h.rows.map((x) => x.providerPriceRefLive)).toEqual([
      'price_pro_m',
      'price_pro_y',
      'price_prem_m',
      'price_prem_y',
    ]);
    // Only the live ref, only where empty; never the test ref, amount or active (no publish).
    for (const u of h.updates) {
      expect(Object.keys(u.data)).toEqual(['providerPriceRefLive']);
      expect(u.where).toMatchObject({ providerPriceRefLive: null });
    }
    expect(h.rows.every((x) => x.active && x.providerPriceRefTest === null)).toBe(true);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      actorUserId: 'admin_1',
      action: 'BILLING_PRICE_PROVIDER_REFS_SYNCED',
      metadata: { mode: 'live', field: 'providerPriceRefLive', unchanged: 0 },
    });
    // Paid, active, Stripe-routed prices only.
    expect(h.findManyArgs[0].where).toEqual({
      country: { in: ['US'] },
      active: true,
      amountMinor: { gt: 0 },
    });
  });

  it('is idempotent: a second run writes nothing and records nothing', async () => {
    const h = harness();
    await h.run();
    const writes = h.updates.length;
    const again = await h.run();
    expect(again.written).toEqual([]);
    expect(again.unchanged).toHaveLength(4);
    expect(h.updates).toHaveLength(writes);
    expect(h.audits).toHaveLength(1);
  });

  it('dryRun reports what it would write and writes nothing', async () => {
    const h = harness();
    const r = await h.run({ dryRun: true });
    expect(r.written).toHaveLength(4);
    expect(h.updates).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.rows.every((x) => x.providerPriceRefLive === null)).toBe(true);
  });

  it.each([
    ['amount', { amountMinor: 2900 }],
    ['currency', { currency: 'CAD' }],
    ['interval', { interval: 'YEAR' as const }],
    ['interval', { intervalCount: 3 }],
    ['active', { active: false }],
    ['tax_behavior', { taxBehavior: 'inclusive' }],
    ['missing', { found: false }],
  ])('refuses the whole run on a %s mismatch, writing nothing', async (field, over) => {
    const h = harness({
      stripe: {
        ...STRIPE,
        etg_premium_usd_month: rec('price_prem_m', 4900, 'MONTH', over),
      },
    });
    const err = await refusal(h.run());
    expect(err.getStatus()).toBe(409);
    expect(err.details).toEqual({
      problems: [
        {
          priceId: 'bp_premium_month',
          lookupKey: 'etg_premium_usd_month',
          problems: expect.arrayContaining([field]),
        },
      ],
    });
    expect(h.updates).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('never overwrites a ref that points at a different Stripe price', async () => {
    const rows = [usd('PRO', 'MONTH', 1900), usd('PRO', 'YEAR', 19000)];
    rows[0].providerPriceRefLive = 'price_someone_else';
    const h = harness({ rows });
    const err = await refusal(h.run());
    expect(JSON.stringify(err.details)).toContain('already_points_elsewhere');
    expect(h.updates).toEqual([]);
    expect(rows[0].providerPriceRefLive).toBe('price_someone_else');
  });

  it('refuses a mode that is not the key mode, an empty catalogue, or no Stripe', async () => {
    const testKey = harness({ mode: 'test' });
    expect((await refusal(testKey.run({ mode: 'live' }))).message).toMatch(/test key/);
    expect(testKey.looked).toEqual([]);
    const empty = harness({ rows: [] });
    expect((await refusal(empty.run())).message).toMatch(/load-provisional/);
    const none = harness({ noLookup: true });
    expect((await refusal(none.run())).code).toBe('BILLING_PROVIDER_UNAVAILABLE');
  });

  it('with a test key, writes test refs only', async () => {
    const h = harness({ mode: 'test' });
    await h.run({ mode: 'test' });
    expect(h.rows.every((x) => x.providerPriceRefTest && x.providerPriceRefLive === null)).toBe(
      true,
    );
  });
});

describe('StripeBillingProvider.findPriceByLookupKey', () => {
  const provider = (list: (args: unknown) => Promise<unknown>) =>
    new StripeBillingProvider({
      secretKey: 'sk_test_x',
      webhookSecret: 'whsec_x',
      mode: 'test',
      client: { prices: { list } } as never,
    });

  it('maps the price carrying the lookup key; none is found:false', async () => {
    const seen: unknown[] = [];
    const p = provider(async (args) => {
      seen.push(args);
      return {
        data: [
          {
            id: 'price_1',
            unit_amount: 19000,
            currency: 'usd',
            recurring: { interval: 'year', interval_count: 1 },
            active: true,
            tax_behavior: 'exclusive',
          },
        ],
      };
    });
    expect(await p.findPriceByLookupKey('etg_pro_usd_year')).toEqual(rec('price_1', 19000, 'YEAR'));
    expect(seen).toEqual([{ lookup_keys: ['etg_pro_usd_year'], limit: 2 }]);
    const none = provider(async () => ({ data: [] }));
    expect(await none.findPriceByLookupKey('etg_x')).toMatchObject({ found: false });
  });
});
