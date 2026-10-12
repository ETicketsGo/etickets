import { PayoutsService } from './payouts.service';

/**
 * The account-state endpoint returns one entry per provider and market the organizer uses, so the
 * summary can never describe a different provider than the panel beneath it. Prisma is faked: the
 * rules themselves are tested in shared-types; this proves the endpoint feeds them the right rows.
 */
interface Fixture {
  country: string | null;
  currencies?: string[];
  rows?: Record<string, unknown>[];
  banks?: { currency: string; verifiedAt: Date | null; rejectedAt?: Date | null }[];
  routeEnabled?: boolean;
}

function service(f: Fixture) {
  const prisma = {
    organizerPayoutAccount: { findMany: async () => f.banks ?? [] },
    organizerPaymentAccount: { findMany: async () => f.rows ?? [] },
    organization: { findUnique: async () => ({ registeredCountry: f.country }) },
    booking: {
      groupBy: async () => (f.currencies ?? []).map((currency) => ({ currency })),
    },
    venue: { findMany: async () => [] },
  };
  return new PayoutsService(
    prisma as never,
    { assertMember: async () => undefined } as never,
    {} as never,
    {} as never,
    { get: () => f.routeEnabled ?? false } as never,
  );
}

const row = (provider: string, over: Record<string, unknown> = {}) => ({
  provider,
  providerAccountId: `${provider}_1`,
  onboardingStatus: 'ENABLED',
  detailsSubmitted: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  requirementsDue: [],
  disabledReason: null,
  ...over,
});
const user = { id: 'u' } as never;

describe('GET /payouts/account-state: per-provider entries', () => {
  it('US only: a single Stripe entry that blocks dollar sales until charges are on', async () => {
    const r = await service({
      country: 'United States',
      rows: [row('stripe', { chargesEnabled: false, payoutsEnabled: false })],
    }).accountState(user, 'o');
    expect(r.providers.map((e) => [e.provider, e.market, e.accepting, e.payouts])).toEqual([
      ['STRIPE', 'CARD', 'BLOCKED', 'UNAVAILABLE'],
    ]);
    expect(r.providerSummary).toEqual({ level: 'ACTION', decidedBy: 'STRIPE' });
  });

  it('India only: Razorpay never blocks sales; platform Route off is a wait', async () => {
    const r = await service({
      country: 'India',
      rows: [row('razorpay')],
      routeEnabled: false,
      banks: [{ currency: 'INR', verifiedAt: null }],
    }).accountState(user, 'o');
    expect(r.providers).toHaveLength(1);
    expect(r.providers[0]).toMatchObject({
      provider: 'RAZORPAY',
      market: 'INR',
      accepting: 'NOT_GATED',
      payouts: 'PENDING',
      bank: 'UNDER_REVIEW',
    });
    expect(r.providerSummary.level).toBe('WAITING');
  });

  it('both: the answer does not depend on which payment row the database returns first', async () => {
    const stripeBad = row('stripe', { chargesEnabled: false });
    const rzpOk = row('razorpay');
    const a = await service({
      country: 'India',
      currencies: ['USD'],
      rows: [rzpOk, stripeBad],
      routeEnabled: true,
    }).accountState(user, 'o');
    const b = await service({
      country: 'India',
      currencies: ['USD'],
      rows: [stripeBad, rzpOk],
      routeEnabled: true,
    }).accountState(user, 'o');
    expect(a.providers).toEqual(b.providers);
    expect(a.providers.map((e) => e.provider)).toEqual(['STRIPE', 'RAZORPAY']);
    expect(a.providerSummary).toEqual({ level: 'ACTION', decidedBy: 'STRIPE' });
    // Razorpay's healthy row must not hide Stripe's blocked dollar sales (the old bug).
    expect(a.providers[0].accepting).toBe('BLOCKED');
    expect(a.providers[1]).toMatchObject({ accepting: 'NOT_GATED', payouts: 'AVAILABLE' });
  });

  it('neither: no registered country and no sales gives no entries', async () => {
    const r = await service({ country: null }).accountState(user, 'o');
    expect(r.providers).toEqual([]);
    expect(r.providerSummary).toEqual({ level: 'NONE', decidedBy: null });
  });

  it('keeps the old flat fields for older clients', async () => {
    const r = await service({ country: 'India' }).accountState(user, 'o');
    expect(r).toHaveProperty('code');
    expect(r).toHaveProperty('payouts');
  });
});
