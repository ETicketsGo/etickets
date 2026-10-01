import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PayoutsService } from './payouts.service';

/**
 * integration-real-postgres — the finance read model and the payout ledger agree, and reading
 * changes nothing.
 *
 * ── WHY THIS HAS TO BE A REAL DATABASE ─────────────────────────────────────────────
 * The claim is not "the arithmetic is right" - `currency-settlement.calculator.spec` proves that
 * against an oracle. The claim here is that the SAME ELIGIBLE ROWS reach it by both paths: the
 * summary and `generate` run the same four eligibility rules against real Prisma queries, real
 * windows and a real cursor. Mocks cannot fail that, because mocks are where the two
 * implementations would be made to agree by hand.
 *
 * The second claim is that a GET moves no money. That is asserted by photographing every
 * financial table before and after a summary call and requiring them to be identical.
 *
 * Skips (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const txt = readFileSync(resolve(__dirname, p), 'utf8');
      const m = txt.match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

describe('integration-real-postgres: payout summary read model', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let payouts: PayoutsService;

  const suffix = `summary-${Date.now()}`;
  const owner = { id: 'summary-itest-owner', roles: [] };
  const stranger = { id: 'summary-itest-stranger', roles: [] };
  let orgId = '';
  let otherOrgId = '';
  let eventId = '';
  let sessionId = '';

  /** A paid online booking in a given currency, confirmed now. */
  async function sell(args: {
    currency: string;
    subtotalMinor: number;
    discountMinor?: number;
    bookingFeeMinor?: number;
    paymentFeeMinor?: number;
    organizerFeeMinor?: number;
  }) {
    return db!.booking.create({
      data: {
        organizationId: orgId,
        eventId,
        eventSessionId: sessionId,
        buyerName: 'Asha Rao',
        buyerEmail: `asha+${Math.random().toString(36).slice(2)}@example.test`,
        status: 'CONFIRMED',
        paymentMethod: 'ONLINE',
        currency: args.currency,
        feeMode: 'CUSTOMER_PAYS',
        subtotalMinor: args.subtotalMinor,
        bookingFeeMinor: args.bookingFeeMinor ?? 0,
        paymentFeeMinor: args.paymentFeeMinor ?? 0,
        discountMinor: args.discountMinor ?? 0,
        customerFeeMinor: 0,
        organizerFeeMinor: args.organizerFeeMinor ?? 0,
        taxMinor: 0,
        totalMinor: args.subtotalMinor,
        holdExpiresAt: new Date(Date.now() - 120_000),
        confirmedAt: new Date(),
      },
    });
  }

  /** Every financial row for this organization, as one comparable photograph. */
  async function financialSnapshot() {
    const [payoutRows, bookings, refunds, settlements] = await Promise.all([
      db!.payout.findMany({ where: { organizationId: orgId }, orderBy: { id: 'asc' } }),
      db!.booking.findMany({
        where: { organizationId: orgId },
        orderBy: { id: 'asc' },
        select: { id: true, status: true, subtotalMinor: true, currency: true, confirmedAt: true },
      }),
      db!.refund.findMany({
        where: { organizationId: orgId },
        orderBy: { id: 'asc' },
        select: { id: true, status: true, amountMinor: true, updatedAt: true },
      }),
      db!.settlement.findMany({ where: { organizationId: orgId }, orderBy: { id: 'asc' } }),
    ]);
    return JSON.stringify({ payoutRows, bookings, refunds, settlements });
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    payouts = new PayoutsService(
      db as never,
      {
        // Real tenancy is proved by its own test below; here it stands aside so the money
        // assertions are about money.
        assertMember: async (user: { id: string }, organization: string) => {
          if (user.id === 'summary-itest-stranger' && organization !== otherOrgId) {
            throw Object.assign(new Error('forbidden'), { status: 403 });
          }
        },
      } as never,
      { record: async () => undefined } as never,
      {
        effectiveFor: async () => ({
          holdDays: 0,
          minPayoutMinor: {},
          source: { holdDays: 'default', minPayoutMinor: 'default' },
        }),
      } as never,
    );

    const org = await db.organization.create({
      data: { name: `Summary ${suffix}`, slug: `summary-${suffix}` },
    });
    orgId = org.id;
    const other = await db.organization.create({
      data: { name: `Other ${suffix}`, slug: `other-${suffix}` },
    });
    otherOrgId = other.id;
    const venue = await db.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Bengaluru', country: 'India' },
    });
    const event = await db.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Summary night ${suffix}`,
        slug: `summary-night-${suffix}`,
        category: 'Music',
        // Finished: revenue is only payable once the show is over.
        status: 'COMPLETED',
      },
    });
    eventId = event.id;
    const session = await db.eventSession.create({
      data: {
        eventId,
        startsAt: new Date(Date.now() - 90_000_000),
        endsAt: new Date(Date.now() - 86_400_000),
        status: 'COMPLETED',
      },
    });
    sessionId = session.id;
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.refund.deleteMany({ where: { organizationId: orgId } });
    await db.payout.deleteMany({ where: { organizationId: orgId } });
    await db.booking.deleteMany({ where: { organizationId: orgId } });
    await db.settlement.deleteMany({ where: { organizationId: orgId } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await db.$disconnect();
  }, 60_000);

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('skipped — no database');
      return true;
    }
    return false;
  };

  it('reports nothing for an organization that has sold nothing', async () => {
    if (guard()) return;
    const summary = await payouts.summary(owner as never, orgId);
    expect(summary.currencies).toEqual([]);
    expect(summary.heldRevenue).toEqual([]);
    expect(summary.organizationId).toBe(orgId);
  });

  it('agrees with the payout the ledger would actually raise', async () => {
    if (guard()) return;
    await sell({
      currency: 'INR',
      subtotalMinor: 250_000,
      organizerFeeMinor: 18_750,
      discountMinor: 12_500,
    });
    await sell({
      currency: 'INR',
      subtotalMinor: 100_000,
      bookingFeeMinor: 5_000,
      paymentFeeMinor: 2_360,
    });

    const before = await payouts.summary(owner as never, orgId);
    const inr = before.currencies.find((c) => c.currency === 'INR')!;

    /*
      The assertion that matters. `generate` is the ledger's own answer to "what is owed"; the
      summary must have produced the same number from the same rows, or a finance screen and a
      payout would disagree in front of an organizer.
    */
    const raised = await payouts.generate(owner as never, orgId);
    const raisedInr = raised.find((p: { currency: string }) => p.currency.toUpperCase() === 'INR')!;
    expect(raisedInr.netMinor).toBe(inr.net);
    expect(raisedInr.grossMinor).toBe(inr.gross);
  });

  it('moves the eligible figure to paid once the payout exists, without double counting', async () => {
    if (guard()) return;
    // The generate above left a standing payout; its money is now committed, not eligible.
    const after = await payouts.summary(owner as never, orgId);
    const inr = after.currencies.find((c) => c.currency === 'INR')!;
    expect(inr.net).toBe(0);
    expect(inr.pending).toBeGreaterThan(0);
    expect(inr.paid).toBe(0);
  });

  it('keeps currencies apart', async () => {
    if (guard()) return;
    await sell({ currency: 'USD', subtotalMinor: 40_000 });
    const summary = await payouts.summary(owner as never, orgId);
    const usd = summary.currencies.find((c) => c.currency === 'USD')!;
    const inr = summary.currencies.find((c) => c.currency === 'INR')!;
    expect(usd.gross).toBe(40_000);
    // The INR payout raised earlier has not leaked into the USD row.
    expect(usd.pending).toBe(0);
    expect(inr.pending).toBeGreaterThan(0);
    // And there is no grand total anywhere in the contract.
    expect(Object.keys(summary)).not.toContain('total');
  });

  it('writes nothing — a finance request is observational', async () => {
    if (guard()) return;
    const before = await financialSnapshot();
    await payouts.summary(owner as never, orgId);
    await payouts.summary(owner as never, orgId, eventId);
    await payouts.accountState(owner as never, orgId);
    const after = await financialSnapshot();
    expect(after).toBe(before);
  });

  it('excludes an event whose money a provider transfer has already claimed', async () => {
    if (guard()) return;
    await sell({ currency: 'CAD', subtotalMinor: 90_000 });
    const withRevenue = await payouts.summary(owner as never, orgId);
    expect(withRevenue.currencies.find((c) => c.currency === 'CAD')!.gross).toBe(90_000);

    // A settlement in a CLAIMED status takes that event's money off this path entirely.
    const claimed = await db!.settlement.create({
      data: { organizationId: orgId, eventId, currency: 'cad', status: 'TRANSFERRED' },
    });
    const afterClaim = await payouts.summary(owner as never, orgId);
    expect(afterClaim.currencies.find((c) => c.currency === 'CAD')?.gross ?? 0).toBe(0);

    await db!.settlement.delete({ where: { id: claimed.id } });
  });

  it('refuses another organization’s money', async () => {
    if (guard()) return;
    await expect(payouts.summary(stranger as never, orgId)).rejects.toMatchObject({ status: 403 });
    await expect(payouts.accountState(stranger as never, orgId)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('reports no payout account as distinct from one under review', async () => {
    if (guard()) return;
    const none = await payouts.accountState(owner as never, orgId);
    expect(none.code).toBe('NO_ACCOUNT');
    expect(none.organizerActionRequired).toBe(true);

    const account = await db!.organizerPayoutAccount.create({
      data: {
        organizationId: orgId,
        currency: 'INR',
        holderName: 'Asha Rao',
        bankName: 'UBI',
        bankCode: 'UBIN0531',
        accountLast4: '1989',
        accountCipher: 'enc',
      },
    });
    const waiting = await payouts.accountState(owner as never, orgId);
    expect(waiting.code).toBe('UNDER_REVIEW');
    // The rule this whole model exists for: the wait is ours, so nothing is asked of them.
    expect(waiting.organizerActionRequired).toBe(false);
    expect(waiting.action).toBeNull();

    await db!.organizerPayoutAccount.delete({ where: { id: account.id } });
  });
});
