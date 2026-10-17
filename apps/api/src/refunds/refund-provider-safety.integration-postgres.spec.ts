import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RefundsService } from './refunds.service';
import { AuditService } from '../audit/audit.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { PaymentOrchestrator } from '../payments/orchestration/payment-orchestrator.service';
import { PaymentErrorCode, PaymentProviderError } from '../payments/domain/payment-errors';
import type {
  PaymentProvider,
  ProviderRefundRecord,
  RefundInput,
} from '../payments/provider/payment-provider.interface';
import type { RequestUser } from '../common/decorators';

/**
 * integration-real-postgres - a refund call whose answer is lost can never pay twice.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────────────
 * The REAL payment orchestrator sits between the refund code and a fake Razorpay adapter, so
 * its retry rules are the production ones. The fake can be told to:
 *   LOST      make the refund, then throw a timeout (the answer was lost on the way back)
 *   TIMEOUT   throw a timeout having made nothing
 *   ONCE      throw a timeout on the first call only, having made nothing; answer after that
 *   REFUSE    answer "failed"
 *   OK        make the refund and answer
 *   INFLIGHT  throw a timeout while the refund is still being made: it is NOT listed by the next
 *             two lookups, then appears. A resend meanwhile times out too. This is what the real
 *             Razorpay TEST API did with a create held past our timeout (H2, 2026-10-16): the
 *             old code resent, saw nothing twice, said "No money moved", and released the
 *             tickets to a second refund that Razorpay then paid as well.
 * and its lookup of a payment's refunds can be told to fail. Every create call is counted, with
 * the key it carried: "the provider was asked to refund N times" is the assertion that matters.
 *
 * Before this change the orchestrator retried a timed-out refund call twice, so LOST paid the
 * customer three times. These tests fail against that code (see the PR for the run).
 *
 * Every row is created here and deleted after. Skips (never fabricates a pass) when no
 * database is reachable.
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

type CreateMode = 'OK' | 'LOST' | 'TIMEOUT' | 'ONCE' | 'REFUSE' | 'INFLIGHT';

describe('integration-real-postgres: refund calls with a lost answer', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  const tag = `itest-rsafe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ids = {
    admin: '',
    org: '',
    venue: '',
    event: '',
    session: '',
    ticketType: '',
    bookings: [] as string[],
  };

  // ── The fake Razorpay: what it made, what it was asked, and how it behaves next ──
  const fake = {
    create: 'OK' as CreateMode,
    lookupFails: false,
    creates: [] as RefundInput[],
    lookups: 0,
    made: new Map<string, ProviderRefundRecord[]>(),
    inflight: [] as { input: RefundInput; hiddenFor: number }[],
    seq: 0,
  };
  const timeout = () =>
    new PaymentProviderError(PaymentErrorCode.PROVIDER_TIMEOUT, 'timed out', 'razorpay');
  function make(input: RefundInput, status: ProviderRefundRecord['status'] = 'COMPLETED') {
    fake.seq += 1;
    const rec: ProviderRefundRecord = {
      refundRef: `rfnd_${tag}_${fake.seq}`,
      amountMinor: input.amountMinor,
      status,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: new Date(),
    };
    fake.made.set(input.providerRef, [...(fake.made.get(input.providerRef) ?? []), rec]);
    return rec;
  }
  const adapter = {
    name: 'razorpay',
    webhookSignatureHeader: 'x-razorpay-signature',
    capabilities: {} as never,
    createPayment: jest.fn(),
    verifyWebhook: jest.fn(),
    refund: jest.fn(async (input: RefundInput) => {
      fake.creates.push(input);
      const mode = fake.create;
      if (mode === 'TIMEOUT') throw timeout();
      if (mode === 'ONCE' && fake.creates.length === 1) throw timeout();
      if (mode === 'INFLIGHT') {
        if (fake.inflight.length === 0) fake.inflight.push({ input, hiddenFor: 2 });
        throw timeout();
      }
      if (mode === 'REFUSE')
        return { providerRef: make(input, 'FAILED').refundRef, status: 'FAILED' };
      const rec = make(input);
      if (mode === 'LOST') throw timeout();
      return { providerRef: rec.refundRef, status: 'COMPLETED' };
    }),
    findPaymentRefunds: jest.fn(async (paymentRef: string) => {
      fake.lookups += 1;
      if (fake.lookupFails) throw new Error('Razorpay answered 503');
      const listed = [...(fake.made.get(paymentRef) ?? [])];
      for (const f of fake.inflight) {
        f.hiddenFor -= 1;
        if (f.hiddenFor === 0) make(f.input); // listed from the NEXT lookup on
      }
      fake.inflight = fake.inflight.filter((f) => f.hiddenFor > 0);
      return listed;
    }),
  } as unknown as PaymentProvider;

  // The real orchestrator, resolving 'razorpay' to the fake. Nothing else is stubbed in it.
  const orchestrator = new PaymentOrchestrator(
    { environment: 'LOCAL', resolveTarget: jest.fn() } as never,
    { get: () => undefined, has: () => false } as never,
    adapter,
    { get: () => adapter } as never,
  );
  // Written against the orchestrator's surface, cast so it also compiles against the old code.
  const orch = orchestrator as unknown as {
    refund: PaymentOrchestrator['refund'];
    findPaymentRefunds?: (ref: string, o: { provider?: string }) => Promise<unknown>;
  };
  const payments = {
    refundPayment: (
      providerRef: string,
      amountMinor: number,
      reason?: string,
      provider?: string,
      currency?: string,
      idempotencyKey?: string,
    ) => orch.refund({ providerRef, amountMinor, reason, currency, idempotencyKey }, { provider }),
    findProviderRefunds: (providerRef: string, provider?: string) => {
      if (!orch.findPaymentRefunds) throw new Error('this orchestrator cannot look refunds up');
      return orch.findPaymentRefunds(providerRef, { provider });
    },
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
        fullName: 'Safety Admin',
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
      // Attempt rows go with their refund (ON DELETE CASCADE).
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
    fake.create = 'OK';
    fake.lookupFails = false;
    fake.creates = [];
    fake.lookups = 0;
    fake.inflight = [];
    strategy.refund.mockClear();
    receipts.issueCreditNote.mockClear();
    notifications.sendCritical.mockClear();
  });

  /** A paid Razorpay booking with one ticket, and a refund for it waiting for a decision. */
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
        reason: 'Safety test',
        ticketIds: [ticket.id],
      },
    });
    return { bookingId: booking.id, ticketId: ticket.id, refundId: refund.id, payId };
  }

  const row = (id: string) => db!.refund.findUnique({ where: { id } });
  const madeFor = (payId: string) =>
    (fake.made.get(payId) ?? []).filter((r) => r.status !== 'FAILED');

  // ── 1 ───────────────────────────────────────────────────────────────────────────────
  it('timeout, lookup finds the refund: recorded as paid, with exactly one create call', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(1);
    fake.create = 'LOST';
    const out = await refunds.process(admin, f.refundId, 'APPROVE');

    expect(fake.creates).toHaveLength(1);
    expect(madeFor(f.payId)).toHaveLength(1); // the customer was paid once
    expect(out?.status).toBe('COMPLETED');
    expect(out?.providerRef).toBe(madeFor(f.payId)[0].refundRef);
    expect(fake.creates[0].idempotencyKey).toBe(`etg-rf-${f.refundId}`);
    expect((await db!.ticket.findUnique({ where: { id: f.ticketId } })).status).toBe('REFUNDED');
    expect(receipts.issueCreditNote).toHaveBeenCalledTimes(1);
    const attempts = await db!.refundProviderAttempt.findMany({ where: { refundId: f.refundId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptNo: 1, outcome: 'UNKNOWN', trigger: 'APPROVAL' });
  }, 60_000);

  // ── 2 ───────────────────────────────────────────────────────────────────────────────
  /** Make the newest attempt look `minutes` old, as if the admin came back later. */
  const ageLastAttempt = async (refundId: string, minutes: number) => {
    const last = await db!.refundProviderAttempt.findFirst({
      where: { refundId },
      orderBy: { attemptNo: 'desc' },
    });
    await db!.refundProviderAttempt.update({
      where: { id: last.id },
      data: { startedAt: new Date(Date.now() - minutes * 60_000) },
    });
  };
  const heldRefundsOn = (bookingId: string) =>
    db!.refund.findMany({
      where: {
        bookingId,
        OR: [
          { status: { in: ['REQUESTED', 'PROCESSING', 'COMPLETED'] } },
          { status: 'FAILED', manualReviewReason: { not: null } },
        ],
      },
    });

  it('timeout, lookup shows no refund yet: held, NOT resent, and not resendable until the call is old', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(2);
    fake.create = 'ONCE';
    await expect(refunds.process(admin, f.refundId, 'APPROVE')).rejects.toMatchObject({
      details: { providerOutcome: 'UNRESOLVED' },
    });

    expect(fake.creates).toHaveLength(1); // no automatic resend
    expect(fake.lookups).toBe(1);
    const r = await row(f.refundId);
    expect(r.status).toBe('FAILED');
    expect(r.manualReviewReason).toMatch(/does not list this refund yet/);
    expect(await heldRefundsOn(f.bookingId)).toHaveLength(1); // its tickets stay covered

    // Straight after, an empty lookup is not proof: refused even with the dashboard tick.
    expect(await refunds.retryCheck(f.refundId)).toMatchObject({
      allowed: false,
      refusal: 'TOO_SOON',
      providerLookup: { kind: 'NONE' },
    });
    await expect(
      refunds.retry(admin, f.refundId, { confirmedNoProviderRefund: true }),
    ).rejects.toMatchObject({ details: { refusal: 'TOO_SOON' } });
    expect(fake.creates).toHaveLength(1);

    // Once the call is old enough to have finished, the empty answer counts: same key.
    await ageLastAttempt(f.refundId, 11);
    expect(await refunds.retryCheck(f.refundId)).toMatchObject({ allowed: true, action: 'SEND' });
    const out = await refunds.retry(admin, f.refundId, {});
    expect(out.outcome).toBe('COMPLETED');
    expect(fake.creates).toHaveLength(2);
    expect(fake.creates[1].idempotencyKey).toBe(fake.creates[0].idempotencyKey);
    expect(madeFor(f.payId)).toHaveLength(1);
  }, 60_000);

  it('a refund still in flight at the provider is never declared "not refunded" or paid twice', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(9);
    fake.create = 'INFLIGHT';
    await expect(refunds.process(admin, f.refundId, 'APPROVE')).rejects.toMatchObject({
      details: { providerOutcome: 'UNRESOLVED' },
    });
    expect(fake.creates).toHaveLength(1);

    // Held, so the same tickets cannot go on a second refund (a new key Razorpay would pay).
    const r = await row(f.refundId);
    expect(r.status).toBe('FAILED');
    expect(r.manualReviewReason).not.toBeNull();
    expect(await heldRefundsOn(f.bookingId)).toHaveLength(1);
    const audit = await db!.auditLog.findMany({
      where: { entityType: 'Refund', entityId: f.refundId },
      select: { action: true },
    });
    expect(audit.map((a: { action: string }) => a.action)).not.toContain('REFUND_FAILED');

    // The provider lists it soon after; the admin retry records it and sends nothing.
    fake.create = 'OK';
    expect((await refunds.retryCheck(f.refundId)).refusal).toBe('TOO_SOON'); // still unlisted
    await ageLastAttempt(f.refundId, 11);
    expect(await refunds.retryCheck(f.refundId)).toMatchObject({
      allowed: true,
      action: 'RECORD_PROVIDER_REFUND',
    });
    expect(await refunds.retry(admin, f.refundId, {})).toMatchObject({
      outcome: 'COMPLETED',
      recorded: true,
    });
    expect(fake.creates).toHaveLength(1);
    expect(madeFor(f.payId)).toHaveLength(1);
  }, 60_000);

  // ── 3 ───────────────────────────────────────────────────────────────────────────────
  it('timeout, lookup fails: held for manual review, and no further create call', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(3);
    fake.create = 'TIMEOUT';
    fake.lookupFails = true;
    await expect(refunds.process(admin, f.refundId, 'APPROVE')).rejects.toMatchObject({
      details: { providerOutcome: 'UNRESOLVED' },
    });

    expect(fake.creates).toHaveLength(1);
    const r = await row(f.refundId);
    expect(r.status).toBe('FAILED');
    expect(r.manualReviewReason).toMatch(/could not be asked/);
    expect(r.manualReviewAt).not.toBeNull();
    expect((await db!.ticket.findUnique({ where: { id: f.ticketId } })).status).toBe('ACTIVE');

    // The admin is told it needs a check, and nothing is sent without one.
    expect(await refunds.retryCheck(f.refundId)).toMatchObject({
      allowed: false,
      needsConfirmation: true,
      manualReviewReason: expect.stringMatching(/could not be asked/),
      providerLookup: { kind: 'UNAVAILABLE' },
    });
    await expect(refunds.retry(admin, f.refundId, {})).rejects.toMatchObject({
      details: { refusal: 'NEEDS_CONFIRMATION' },
    });
    expect(fake.creates).toHaveLength(1);

    // While it is held, the same tickets cannot be put on a second refund.
    const open = await db!.refund.findMany({
      where: {
        bookingId: f.bookingId,
        OR: [
          { status: { in: ['REQUESTED', 'PROCESSING', 'COMPLETED'] } },
          { status: 'FAILED', manualReviewReason: { not: null } },
        ],
      },
    });
    expect(open).toHaveLength(1);
  }, 60_000);

  // ── Admin retry: the same reconcile-first path ─────────────────────────────────────
  it('an admin retry records a refund the provider already made, and sends nothing', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(4);
    fake.create = 'LOST';
    fake.lookupFails = true; // the refund was made, but the provider could not be asked then
    await expect(refunds.process(admin, f.refundId, 'APPROVE')).rejects.toBeDefined();
    expect((await row(f.refundId)).status).toBe('FAILED');
    expect(fake.creates).toHaveLength(1);

    fake.lookupFails = false; // later, the lookup answers
    expect(await refunds.retryCheck(f.refundId)).toMatchObject({
      allowed: true,
      action: 'RECORD_PROVIDER_REFUND',
      providerLookup: { kind: 'FOUND' },
    });
    const r = await refunds.retry(admin, f.refundId, {});
    expect(r).toMatchObject({ outcome: 'COMPLETED', recorded: true });
    expect(fake.creates).toHaveLength(1); // no second money call
    expect(madeFor(f.payId)).toHaveLength(1);
    const after = await row(f.refundId);
    expect(after.providerRef).toBe(madeFor(f.payId)[0].refundRef);
    expect(after.manualReviewReason).toBeNull();
    expect((await db!.ticket.findUnique({ where: { id: f.ticketId } })).status).toBe('REFUNDED');
  }, 60_000);

  it('an admin retry after a lost answer and an empty lookup resends under the same key', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(5);
    fake.create = 'TIMEOUT';
    fake.lookupFails = true;
    await expect(refunds.process(admin, f.refundId, 'APPROVE')).rejects.toBeDefined();
    const firstKey = fake.creates[0].idempotencyKey;

    fake.create = 'OK';
    fake.lookupFails = false;
    // The lost call is fresh: an empty lookup is not yet proof.
    expect((await refunds.retryCheck(f.refundId)).refusal).toBe('TOO_SOON');
    await ageLastAttempt(f.refundId, 11);
    expect(await refunds.retryCheck(f.refundId)).toMatchObject({
      allowed: true,
      action: 'SEND',
      needsConfirmation: false,
      providerLookup: { kind: 'NONE' },
    });
    const r = await refunds.retry(admin, f.refundId, {});
    expect(r.outcome).toBe('COMPLETED');
    expect(fake.creates).toHaveLength(2);
    expect(fake.creates[1].idempotencyKey).toBe(firstKey);
  }, 60_000);

  it('a refused refund retried by an admin gets a NEW key (the old one was answered)', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(6);
    fake.create = 'REFUSE';
    await expect(refunds.process(admin, f.refundId, 'APPROVE')).rejects.toBeDefined();
    fake.create = 'OK';
    const r = await refunds.retry(admin, f.refundId, {});
    expect(r.outcome).toBe('COMPLETED');
    expect(fake.creates.map((c) => c.idempotencyKey)).toEqual([
      `etg-rf-${f.refundId}`,
      `etg-rf-${f.refundId}-2`,
    ]);
  }, 60_000);

  // ── 5 ───────────────────────────────────────────────────────────────────────────────
  it('two admins retrying at once reach the provider exactly once, even when its answer is lost', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(7);
    fake.create = 'REFUSE';
    await expect(refunds.process(admin, f.refundId, 'APPROVE')).rejects.toBeDefined();
    fake.creates = [];

    fake.create = 'LOST';
    const results = await Promise.allSettled([
      refunds.retry(admin, f.refundId, {}),
      refunds.retry(admin, f.refundId, {}),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(fake.creates).toHaveLength(1);
    expect(madeFor(f.payId)).toHaveLength(1);
    expect((await row(f.refundId)).status).toBe('COMPLETED');
    expect(receipts.issueCreditNote).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('the database refuses a second attempt row with the same number', async () => {
    if (!available) return;
    const f = await paidBookingWithRefund(8);
    const data = { refundId: f.refundId, attemptNo: 1, idempotencyKey: 'k', trigger: 'APPROVAL' };
    await db!.refundProviderAttempt.create({ data });
    await expect(db!.refundProviderAttempt.create({ data })).rejects.toMatchObject({
      code: 'P2002',
    });
  }, 60_000);
});
