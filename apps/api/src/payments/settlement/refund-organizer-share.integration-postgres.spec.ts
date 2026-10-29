import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RazorpayWebhookProcessor } from '../razorpay/razorpay-webhook.processor';
import { SettlementService } from './settlement.service';
import {
  calculateCurrencySettlement,
  organizerShareOfRefund,
} from '../../payouts/currency-settlement.calculator';

/**
 * integration-real-postgres - R1: the refund webhook deducts the payout ledger's share.
 *
 * QA booking ETG-IND-2026-000081: payment 105570, organizer net 100000, a COMPLETED refund of
 * 100000 with no platform fee returned. The settlement used to deduct the pro-rata share
 * (100000 * 100000 / 105570 = 94724) while the payout ledger deducted `organizerShareOfRefund`
 * (100000), so reconciliation showed a 5276 difference. The webhook now reads our own refund
 * row, and both sides deduct 100000.
 *
 * The real Razorpay webhook processor runs against real rows: a mocked Prisma would prove
 * nothing about which refund row the processor finds or what lands in `refundsMinor`.
 *
 * Also proven: a settlement written before the fix is NOT recomputed. Its 94724 stays.
 *
 * Skips (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../.env', '../../../../../.env']) {
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

describe('integration-real-postgres: R1 refund organizer share', () => {
  const url = loadDatabaseUrl();
  let db: Client | null = null;
  let available = false;
  const stamp = `r1-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let orgId = '';
  const webhookIds: string[] = [];

  beforeAll(async () => {
    if (!url) return;
    try {
      db = new PrismaClient({ datasources: { db: { url } } });
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      available = false;
      return;
    }
    const org = await db!.organization.create({
      data: { name: `R1 ${stamp}`, slug: stamp, status: 'APPROVED' },
    });
    orgId = org.id;
  }, 60_000);

  afterAll(async () => {
    if (!available || !db) return;
    await db.webhookEvent.deleteMany({ where: { id: { in: webhookIds } } }).catch(() => {});
    await db.refund.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.payment.deleteMany({ where: { booking: { organizationId: orgId } } }).catch(() => {});
    await db.booking.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.settlement.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.eventSession
      .deleteMany({ where: { event: { organizationId: orgId } } })
      .catch(() => {});
    await db.event.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.venue.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
    await db.$disconnect();
  }, 60_000);

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped - DB unavailable');
      return true;
    }
    return false;
  };

  let seq = 0;
  async function eventWithSettlement(refundsMinor = 0) {
    seq += 1;
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `V ${stamp} ${seq}`,
        city: 'Vijayawada',
        country: 'India',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `R1 ${stamp} ${seq}`,
        slug: `${stamp}-${seq}`,
        category: 'Music',
        status: 'PUBLISHED',
      },
    });
    const session = await db!.eventSession.create({
      data: {
        eventId: event.id,
        startsAt: new Date('2031-06-01T14:30:00Z'),
        endsAt: new Date('2031-06-01T17:00:00Z'),
        status: 'SCHEDULED',
      },
    });
    // PENDING and never transferred: a refund only accrues, nothing is reversed at a provider.
    const settlement = await db!.settlement.create({
      data: {
        organizationId: orgId,
        eventId: event.id,
        currency: 'inr',
        provider: 'razorpay',
        status: 'PENDING',
        refundsMinor,
      },
    });
    return { event, session, settlement };
  }

  function processor() {
    const resolver = { get: () => ({}) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const settlements = new SettlementService(
      db as never,
      audit as never,
      {} as never,
      {} as never,
      resolver as never,
    );
    return new RazorpayWebhookProcessor(
      db as never,
      {} as never,
      settlements,
      {} as never,
      audit as never,
    );
  }

  it('deducts 100000 (the payout ledger share), not the pro-rata 94724; difference 0', async () => {
    if (guard()) return;
    const { event, session, settlement } = await eventWithSettlement();
    // A settlement written before the fix, on another event: it must not be recomputed.
    const historical = await eventWithSettlement(94_724);
    const before = await db!.settlement.findUnique({ where: { id: historical.settlement.id } });

    const booking = await db!.booking.create({
      data: {
        organizationId: orgId,
        eventId: event.id,
        eventSessionId: session.id,
        buyerName: 'R1 Buyer',
        buyerEmail: `${stamp}@example.test`,
        status: 'CONFIRMED',
        paymentMethod: 'ONLINE',
        feeMode: 'CUSTOMER_PAYS',
        currency: 'INR',
        subtotalMinor: 100_000,
        bookingFeeMinor: 5_570,
        paymentFeeMinor: 0,
        discountMinor: 0,
        customerFeeMinor: 5_570,
        organizerFeeMinor: 0,
        taxMinor: 0,
        totalMinor: 105_570,
        confirmedAt: new Date(),
        holdExpiresAt: new Date(),
      },
    });
    const payId = `pay_${stamp}`;
    const rfndId = `rfnd_${stamp}`;
    await db!.payment.create({
      data: {
        bookingId: booking.id,
        provider: 'razorpay',
        status: 'SUCCEEDED',
        amountMinor: 105_570,
        currency: 'INR',
        providerPaymentIntentId: payId,
        subtotalMinor: 100_000,
        organizerNetMinor: 100_000,
      },
    });
    // Our own refund row, already COMPLETED: the ticket money, no platform fee returned.
    await db!.refund.create({
      data: {
        bookingId: booking.id,
        organizationId: orgId,
        amountMinor: 100_000,
        taxAddedMinor: 0,
        platformFeeRefundedMinor: 0,
        status: 'COMPLETED',
        reason: 'Buyer asked for a refund.',
        providerRef: rfndId,
        ticketIds: [],
      },
    });
    const hook = await db!.webhookEvent.create({
      data: {
        provider: 'razorpay',
        providerEventId: `evt_${stamp}`,
        eventType: 'refund.processed',
        processingStatus: 'RECEIVED',
        payload: {
          object: {
            refund: {
              entity: { id: rfndId, payment_id: payId, amount: 100_000, currency: 'INR' },
            },
          },
        },
      },
    });
    webhookIds.push(hook.id);

    await processor().process(hook.id);

    const processed = await db!.webhookEvent.findUnique({ where: { id: hook.id } });
    expect(processed!.errorMessage).toBeNull();
    expect(processed!.processingStatus).toBe('PROCESSED');

    const after = await db!.settlement.findUnique({ where: { id: settlement.id } });
    expect(after!.refundsMinor).toBe(100_000);

    // The payout ledger's deduction for the same refund rows.
    const rows = await db!.refund.findMany({
      where: { bookingId: booking.id, status: 'COMPLETED' },
      select: { amountMinor: true, taxAddedMinor: true, platformFeeRefundedMinor: true },
    });
    const ledgerShare = rows.reduce(
      (
        s: number,
        r: {
          amountMinor: number;
          taxAddedMinor: number | null;
          platformFeeRefundedMinor: number | null;
        },
      ) => s + organizerShareOfRefund({ currency: 'INR', ...r }),
      0,
    );
    expect(ledgerShare).toBe(100_000);
    const [ledger] = calculateCurrencySettlement({
      revenue: [],
      refunds: rows.map((r: object) => ({ currency: 'INR', ...r }) as never),
    });
    expect(ledger.refund).toBe(100_000);
    // Reconciliation: settlement deduction minus ledger deduction.
    expect(after!.refundsMinor - ledger.refund).toBe(0);

    // A redelivery under a new event id for the same refund adds nothing.
    const again = await db!.webhookEvent.create({
      data: {
        provider: 'razorpay',
        providerEventId: `evt2_${stamp}`,
        eventType: 'refund.processed',
        processingStatus: 'RECEIVED',
        payload: processed!.payload as never,
      },
    });
    webhookIds.push(again.id);
    await processor().process(again.id);
    expect((await db!.settlement.findUnique({ where: { id: settlement.id } }))!.refundsMinor).toBe(
      100_000,
    );

    // Historical preserved: the pre-fix settlement is not recomputed.
    const historicalAfter = await db!.settlement.findUnique({
      where: { id: historical.settlement.id },
    });
    expect(historicalAfter!.refundsMinor).toBe(94_724);
    expect(historicalAfter!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  }, 60_000);
});
