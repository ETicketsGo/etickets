import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RefundsService } from './refunds.service';
import { AuditService } from '../audit/audit.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/**
 * integration-real-postgres - trying a FAILED refund again can never pay a customer twice.
 *
 * ── WHAT THIS PROVES THAT THE UNIT SPEC CANNOT ─────────────────────────────────────
 *  - Five admins pressing Try again at once reach the provider exactly once: the claim
 *    FAILED -> PROCESSING is a real conditional UPDATE, and the marker that a provider call is
 *    about to happen commits with it.
 *  - A refund the provider refused goes through the approval's own code on retry: tickets
 *    voided, booking marked refunded, one credit note, one customer notice.
 *  - A refund the provider accepted and failed later is retried for the money ONLY: its
 *    tickets are not voided a second time and no second credit note is issued.
 *  - A call that never answered is not retried without the admin's word, and a provider refund
 *    on the payment that no row accounts for (read from the stored webhooks with a JSON path)
 *    stops it outright.
 *
 * The payment provider is a stub whose next answer each test sets, and every call is counted:
 * "the provider was asked N times" is the assertion that matters. Every row is created here and
 * deleted after. Skips (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const m = readFileSync(resolve(__dirname, p), 'utf8').match(/^DATABASE_URL=(.*)$/m);
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

type Answer = 'COMPLETED' | 'PROCESSING' | 'FAILED' | 'THROW';

describe('integration-real-postgres: retrying a failed refund', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  const tag = `itest-rretry-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ids = {
    admin: '',
    org: '',
    venue: '',
    event: '',
    session: '',
    ticketType: '',
    bookings: [] as string[],
    webhooks: [] as string[],
  };

  // The provider: its next answer, and how many times it was asked.
  const provider = { next: 'COMPLETED' as Answer, calls: 0, delayMs: 0, seq: 0 };
  const payments = {
    refundPayment: jest.fn(async (paymentRef: string) => {
      provider.calls += 1;
      if (provider.delayMs) await new Promise((r) => setTimeout(r, provider.delayMs));
      if (provider.next === 'THROW') throw new Error('provider timed out');
      provider.seq += 1;
      return { providerRef: `rfnd_${tag}_${provider.seq}`, status: provider.next, paymentRef };
    }),
  };
  const strategy = { refund: jest.fn().mockResolvedValue(undefined) };
  const inventory = { forSeating: () => strategy };
  const notifications = { sendCritical: jest.fn().mockResolvedValue(undefined) };
  const receipts = { issueCreditNote: jest.fn().mockResolvedValue(undefined) };
  const metrics = { recordRefundCompleted: jest.fn() };
  let refunds: RefundsService;
  let admin: RequestUser;

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[integration-real-postgres] SKIPPED - DB unavailable: ${(err as Error).message}`,
      );
      return;
    }
    const audit = new AuditService(db as never);
    const access = new OrgAccessService(db as never, audit);
    refunds = new RefundsService(
      db as never,
      payments as never,
      inventory as never,
      access,
      audit,
      notifications as never,
      metrics as never,
      receipts as never,
    );
    const u = await db.user.create({
      data: {
        email: `${tag}-admin@example.test`,
        passwordHash: 'x',
        fullName: 'Retry Admin',
        roles: ['SUPER_ADMIN'],
      },
    });
    ids.admin = u.id;
    admin = { id: u.id, email: u.email, fullName: u.fullName, roles: ['SUPER_ADMIN'] as never };
    const org = await db.organization.create({ data: { name: tag, slug: `${tag}-org` } });
    ids.org = org.id;
    const venue = await db.venue.create({
      data: { organizationId: org.id, name: tag, city: 'Testville' },
    });
    ids.venue = venue.id;
    const event = await db.event.create({
      data: {
        organizationId: org.id,
        venueId: venue.id,
        title: tag,
        slug: `${tag}-evt`,
        category: 'test',
      },
    });
    ids.event = event.id;
    const session = await db.eventSession.create({
      data: { eventId: event.id, startsAt: new Date('2099-01-01'), endsAt: new Date('2099-01-02') },
    });
    ids.session = session.id;
    const tt = await db.ticketType.create({
      data: { eventSessionId: session.id, name: 'General', priceMinor: 5000, quantityTotal: 100 },
    });
    ids.ticketType = tt.id;
  }, 60_000);

  afterAll(async () => {
    if (db && available) {
      const refundIds = (
        await db.refund.findMany({
          where: { bookingId: { in: ids.bookings } },
          select: { id: true },
        })
      ).map((r: { id: string }) => r.id);
      await db.auditLog
        .deleteMany({
          where: { OR: [{ entityId: { in: refundIds } }, { organizationId: ids.org }] },
        })
        .catch(() => undefined);
      await db.webhookEvent
        .deleteMany({ where: { id: { in: ids.webhooks } } })
        .catch(() => undefined);
      await db.refund
        .deleteMany({ where: { bookingId: { in: ids.bookings } } })
        .catch(() => undefined);
      await db.ticket
        .deleteMany({ where: { bookingId: { in: ids.bookings } } })
        .catch(() => undefined);
      await db.payment
        .deleteMany({ where: { bookingId: { in: ids.bookings } } })
        .catch(() => undefined);
      await db.booking.deleteMany({ where: { id: { in: ids.bookings } } }).catch(() => undefined);
      await db.ticketType.deleteMany({ where: { id: ids.ticketType } }).catch(() => undefined);
      await db.eventSession.deleteMany({ where: { id: ids.session } }).catch(() => undefined);
      await db.event.deleteMany({ where: { id: ids.event } }).catch(() => undefined);
      await db.venue.deleteMany({ where: { id: ids.venue } }).catch(() => undefined);
      await db.organization.deleteMany({ where: { id: ids.org } }).catch(() => undefined);
      await db.auditLog.deleteMany({ where: { actorUserId: ids.admin } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: ids.admin } }).catch(() => undefined);
    }
    await db?.$disconnect().catch(() => undefined);
  });

  beforeEach(() => {
    provider.next = 'COMPLETED';
    provider.calls = 0;
    provider.delayMs = 0;
    strategy.refund.mockClear();
    receipts.issueCreditNote.mockClear();
    notifications.sendCritical.mockClear();
  });

  /** A paid booking with one ticket, and a refund for it waiting for a decision. */
  async function paidBookingWithRefund(n: number) {
    const booking = await db!.booking.create({
      data: {
        organizationId: ids.org,
        eventId: ids.event,
        eventSessionId: ids.session,
        buyerName: 'Buyer',
        buyerEmail: `${tag}-${n}@example.test`,
        status: 'CONFIRMED',
        currency: 'INR',
        subtotalMinor: 5000,
        totalMinor: 5000,
        holdExpiresAt: new Date('2099-01-01'),
      },
    });
    ids.bookings.push(booking.id);
    const payId = `pay_${tag}_${n}`;
    await db!.payment.create({
      data: {
        bookingId: booking.id,
        provider: 'razorpay',
        status: 'SUCCEEDED',
        amountMinor: 5000,
        currency: 'INR',
        refundedMinor: 0,
        providerRef: payId,
        providerPaymentIntentId: payId,
      },
    });
    const ticket = await db!.ticket.create({
      data: {
        bookingId: booking.id,
        ticketTypeId: ids.ticketType,
        eventSessionId: ids.session,
        organizationId: ids.org,
        serial: `${tag}-${n}`,
        nonce: 'n',
      },
    });
    const refund = await db!.refund.create({
      data: {
        bookingId: booking.id,
        organizationId: ids.org,
        amountMinor: 5000,
        reason: 'Retry test',
        ticketIds: [ticket.id],
      },
    });
    return { bookingId: booking.id, ticketId: ticket.id, refundId: refund.id, payId };
  }

  async function failByProvider(refundId: string, answer: Answer) {
    provider.next = answer;
    await expect(refunds.process(admin, refundId, 'APPROVE')).rejects.toBeDefined();
    expect((await db!.refund.findUnique({ where: { id: refundId } })).status).toBe('FAILED');
  }

  it('retries a refused refund through the approval path, then refuses a third try', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(1);
    await failByProvider(f.refundId, 'FAILED');
    expect((await db!.ticket.findUnique({ where: { id: f.ticketId } })).status).toBe('ACTIVE');

    expect(await refunds.retryCheck(f.refundId)).toMatchObject({
      allowed: true,
      stage: 'TICKETS_HELD',
      lastAnswer: 'REFUSED',
    });

    // Refused again: shown, not thrown, and still retryable.
    provider.next = 'FAILED';
    const again = await refunds.retry(admin, f.refundId, {});
    expect(again.outcome).toBe('FAILED');
    expect((await db!.refund.findUnique({ where: { id: f.refundId } })).status).toBe('FAILED');

    provider.next = 'COMPLETED';
    const ok = await refunds.retry(admin, f.refundId, {});
    expect(ok.outcome).toBe('COMPLETED');
    expect(ok.providerRef).toMatch(/^rfnd_/);
    expect((await db!.ticket.findUnique({ where: { id: f.ticketId } })).status).toBe('REFUNDED');
    expect((await db!.booking.findUnique({ where: { id: f.bookingId } })).status).toBe('REFUNDED');
    expect(receipts.issueCreditNote).toHaveBeenCalledTimes(1);
    // One refund notice, and one BOOKING_CANCELLED (SMS only) because the booking ended.
    const told = notifications.sendCritical.mock.calls.map(
      (c: unknown[]) => (c[1] as { type: string }).type,
    );
    expect(told.filter((t) => t === 'REFUND_COMPLETED')).toHaveLength(1);
    expect(told.filter((t) => t === 'BOOKING_CANCELLED')).toHaveLength(1);
    expect(told).toHaveLength(2);
    expect(provider.calls).toBe(3); // approval + two retries

    await expect(refunds.retry(admin, f.refundId, {})).rejects.toBeInstanceOf(AppException);
    expect(provider.calls).toBe(3);

    const actions = (
      await db!.auditLog.findMany({
        where: { entityType: 'Refund', entityId: f.refundId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((a: { action: string }) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'REFUND_RETRY_STARTED',
        'REFUND_RETRY_RESULT',
        'REFUND_RETRY_REFUSED',
      ]),
    );
  }, 60_000);

  it('asks the provider exactly once when five retries race', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(2);
    await failByProvider(f.refundId, 'FAILED');
    provider.calls = 0;
    provider.next = 'COMPLETED';
    provider.delayMs = 300;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => refunds.retry(admin, f.refundId, {})),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(provider.calls).toBe(1);
    expect(strategy.refund).toHaveBeenCalledTimes(1);
    expect(receipts.issueCreditNote).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('will not resend an unanswered refund until the admin has checked the provider', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(3);
    await failByProvider(f.refundId, 'THROW');
    provider.calls = 0;

    expect(await refunds.retryCheck(f.refundId)).toMatchObject({
      allowed: false,
      needsConfirmation: true,
      lastAnswer: 'UNKNOWN',
    });
    await expect(refunds.retry(admin, f.refundId, {})).rejects.toMatchObject({
      details: { refusal: 'NEEDS_CONFIRMATION' },
    });
    expect(provider.calls).toBe(0);

    // A retry that itself goes unanswered leaves it needing the check again. This stub cannot
    // be asked for the payment's refunds, so the refund is held for review, never resent.
    provider.next = 'THROW';
    const lost = await refunds.retry(admin, f.refundId, { confirmedNoProviderRefund: true });
    expect(lost.outcome).toBe('NEEDS_REVIEW');
    expect(await refunds.retryCheck(f.refundId)).toMatchObject({ needsConfirmation: true });

    provider.next = 'COMPLETED';
    const ok = await refunds.retry(admin, f.refundId, { confirmedNoProviderRefund: true });
    expect(ok.outcome).toBe('COMPLETED');
    expect(provider.calls).toBe(2);
  }, 60_000);

  it('resends only the money for a refund the provider accepted and then failed', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(4);
    provider.next = 'PROCESSING';
    await refunds.process(admin, f.refundId, 'APPROVE');
    expect((await db!.ticket.findUnique({ where: { id: f.ticketId } })).status).toBe('REFUNDED');
    // What the Razorpay webhook does on `refund.failed`.
    const first = (await db!.refund.findUnique({ where: { id: f.refundId } })).providerRef;
    await db!.refund.update({ where: { id: f.refundId }, data: { status: 'FAILED' } });
    await db!.auditLog.create({
      data: {
        organizationId: ids.org,
        action: 'REFUND_FAILED_AT_PROVIDER',
        entityType: 'Refund',
        entityId: f.refundId,
        metadata: { providerRefundId: first },
      },
    });
    strategy.refund.mockClear();
    receipts.issueCreditNote.mockClear();
    notifications.sendCritical.mockClear();

    expect(await refunds.retryCheck(f.refundId)).toMatchObject({
      allowed: true,
      stage: 'TICKETS_RETURNED',
    });
    provider.next = 'PROCESSING';
    const r = await refunds.retry(admin, f.refundId, {});
    expect(r.outcome).toBe('PROCESSING');
    expect(r.providerRef).not.toBe(first);
    expect(strategy.refund).not.toHaveBeenCalled();
    expect(receipts.issueCreditNote).not.toHaveBeenCalled();
    expect(notifications.sendCritical).not.toHaveBeenCalled();
    expect((await db!.ticket.findUnique({ where: { id: f.ticketId } })).status).toBe('REFUNDED');
  }, 60_000);

  it('stops when the provider reports a refund on the payment that nothing here accounts for', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(5);
    await failByProvider(f.refundId, 'FAILED');
    provider.calls = 0;
    const w = await db!.webhookEvent.create({
      data: {
        provider: 'razorpay',
        providerEventId: `${tag}-evt-5`,
        eventType: 'refund.processed',
        payload: {
          object: { refund: { entity: { id: `rfnd_${tag}_stranger`, payment_id: f.payId } } },
        },
      },
    });
    ids.webhooks.push(w.id);
    expect(await refunds.retryCheck(f.refundId)).toMatchObject({
      allowed: false,
      refusal: 'UNMATCHED_PROVIDER_REFUND',
    });
    await expect(
      refunds.retry(admin, f.refundId, { confirmedNoProviderRefund: true }),
    ).rejects.toMatchObject({ details: { refusal: 'UNMATCHED_PROVIDER_REFUND' } });
    expect(provider.calls).toBe(0);
  }, 60_000);

  it('refuses a refund whose tickets already went back through another refund', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(6);
    const second = await db!.refund.create({
      data: {
        bookingId: f.bookingId,
        organizationId: ids.org,
        amountMinor: 5000,
        reason: 'Asked twice',
        ticketIds: [f.ticketId],
      },
    });
    await refunds.process(admin, f.refundId, 'APPROVE');
    await expect(refunds.process(admin, second.id, 'APPROVE')).rejects.toBeDefined();
    provider.calls = 0;
    expect(await refunds.retryCheck(second.id)).toMatchObject({
      allowed: false,
      refusal: 'TICKETS_GONE',
    });
    await expect(
      refunds.retry(admin, second.id, { confirmedNoProviderRefund: true }),
    ).rejects.toBeInstanceOf(AppException);
    expect(provider.calls).toBe(0);
  }, 60_000);
});
