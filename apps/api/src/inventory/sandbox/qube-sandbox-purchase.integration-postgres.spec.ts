import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncPollingService } from '../sync/sync-polling.service';
import { SyncEventProcessor } from '../sync/sync-event.processor';
import { SyncCheckpointService } from '../sync/sync-checkpoint.service';
import { SyncOpsService } from '../sync/sync-ops.service';
import { SandboxCatalogueMaterializer } from './sandbox-catalogue.materializer';
import { QubeMockInventoryProvider } from '../sourcing/providers/qube/qube-mock.provider';
import { InventoryProviderRegistry } from '../sourcing/inventory-provider.registry';
import { QUBE_MOCK_PROVIDER_CODE } from '../sourcing/providers/qube/qube-mock.fixture';
import { BookingExecutionRouter } from '../../bookings/orchestration/booking-execution-router.service';
import { ProviderAuthoritativeStrategy } from '../../bookings/orchestration/provider-authoritative.strategy';
import { PaymentsService } from '../../payments/payments.service';
import { ShowsService } from '../../shows/shows.service';
import type { RequestUser } from '../../common/decorators';

/**
 * integration-real-postgres — a customer buys seat F10 in a cinema ETicketsGo does not own.
 *
 * ── WHAT THIS CLOSES ───────────────────────────────────────────────────────────────
 * The previous report said, plainly, that the seams composed but nobody had bought a seat.
 * Every earlier Qube test built its own harness: real objects, real logic, but wired by the
 * test. That proves the pieces work and says nothing about whether the APPLICATION uses them.
 *
 * This boots the whole Nest application against a real PostgreSQL and a real Redis, with the
 * sandbox flags on, and drives one purchase from catalogue sync to QR code through the same
 * `BookingExecutionRouter` the HTTP controller calls and the same `PaymentsService.mockPay`
 * the checkout page hits. Nothing is hand-wired. What it does NOT exercise is the HTTP layer
 * itself — routing, guards, validation pipes — which is stated here rather than implied.
 *
 * SKIPS VISIBLY when PostgreSQL or Redis is unreachable. It never fabricates a pass.
 */

function loadEnvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const m = readFileSync(resolve(__dirname, p), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Is there actually a PostgreSQL and a Redis here? The only legitimate reason to skip. */
async function infrastructureReachable(databaseUrl: string, redisUrl: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const IORedis = require('ioredis');
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const redis = new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await db.$queryRaw`SELECT 1`;
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    await db.$disconnect().catch(() => undefined);
    redis.disconnect();
  }
}

/**
 * OUR prices, deliberately different from every number the provider publishes.
 *
 * The sandbox advertises 180 / 220 / 280 / 450. If a ticket ever costs one of those, a vendor
 * figure has reached a customer — and the whole "pricing is ours" rule is being obeyed by
 * coincidence rather than by construction. Different numbers make the violation visible.
 */
const OUR_PRICES: Record<string, number> = {
  'QBCAT-NORMAL': 19_500,
  'QBCAT-EXEC': 24_500,
  'QBCAT-PREMIUM': 31_000,
  'QBCAT-RECLINER': 49_900,
};
const VENDOR_PRICES = [18_000, 22_000, 28_000, 45_000];

const TENANT = '';

describe('integration-real-postgres: a real purchase from the Qube sandbox', () => {
  let app: INestApplicationContext | undefined;
  let available = false;

  let prisma: PrismaService;
  let polling: SyncPollingService;
  let processor: SyncEventProcessor;
  let checkpoints: SyncCheckpointService;
  let ops: SyncOpsService;
  let materializer: SandboxCatalogueMaterializer;
  let sandbox: QubeMockInventoryProvider;
  let registry: InventoryProviderRegistry;
  let router: BookingExecutionRouter;
  let strategy: ProviderAuthoritativeStrategy;
  let payments: PaymentsService;
  let shows: ShowsService;

  /**
   * The environment this file found, so it can put it back.
   *
   * Jest workers are processes, and several test files share one. Turning on a sandbox
   * provider and an active orchestrator for the rest of a worker's life would make unrelated
   * specs pass or fail depending on which file happened to run first — the kind of failure
   * that reproduces only in CI and only sometimes.
   */
  const originalEnv = { ...process.env };

  const suffix = `qbe-${Date.now()}`;
  let orgId = '';
  let operator: RequestUser;
  let buyer: RequestUser;
  let buyerTwo: RequestUser;

  beforeAll(async () => {
    const url = loadEnvValue('DATABASE_URL');
    const redis = loadEnvValue('REDIS_URL');
    if (!url || !redis || !(await infrastructureReachable(url, redis))) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — PostgreSQL/Redis not reachable');
      return;
    }
    // Set BEFORE the module compiles: configuration is validated at ConfigModule init, and
    // these are exactly the flags whose production combinations that validation forbids.
    Object.assign(process.env, {
      DATABASE_URL: url,
      REDIS_URL: redis,
      APP_ENV: 'LOCAL',
      PAYMENT_PROVIDER_NAME: 'mock',
      INVENTORY_SOURCING_ENABLED: 'true',
      INVENTORY_QUBE_MOCK_ENABLED: 'true',
      INVENTORY_SANDBOX_MATERIALIZATION_ENABLED: 'true',
      INVENTORY_SYNC_ENABLED: 'true',
      INVENTORY_SYNC_POLLING_ENABLED: 'true',
      INVENTORY_SYNC_PROCESSING_ENABLED: 'true',
      // Sync refuses to accept a provider it was not told to trust, which is the right
      // default and one more thing a real rollout has to do deliberately.
      INVENTORY_SYNC_PROVIDER_ALLOWLIST: QUBE_MOCK_PROVIDER_CODE,
      BOOKING_ORCHESTRATOR_ENABLED: 'true',
      BOOKING_ORCHESTRATOR_MODE: 'active',
      BOOKING_PROVIDER_CONFIRMATION_ENABLED: 'true',
      BOOKING_PROVIDER_STATUS_RECOVERY_ENABLED: 'true',
    });

    /*
      Deliberately NOT wrapped in a try/catch.

      The first version of this file caught every boot error and reported it as "environment
      unavailable". A missing provider allowlist — a genuine configuration bug — came back as
      thirteen passing tests that had run nothing. Infrastructure is probed above, where a
      real absence belongs; past that point a refusal to start is a failure and says so.
    */
    {
      /*
        Required, not imported.

        `ConfigModule.forRoot()` validates the environment SYNCHRONOUSLY, at the moment
        `app.module.ts` is first loaded — not when the application starts. A static import
        would therefore capture the environment before the flags above were set, and the app
        would boot with the sandbox off while `process.env` insisted it was on. That failure
        looks exactly like a broken feature and is not one.
      */
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AppModule } = require('../../app.module');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      // init() runs the lifecycle hooks — which is where providers actually get registered.
      app = await moduleRef.init();
      prisma = app.get(PrismaService);
      await prisma.$queryRaw`SELECT 1`;
      available = true;
    }

    polling = app.get(SyncPollingService);
    processor = app.get(SyncEventProcessor);
    checkpoints = app.get(SyncCheckpointService);
    ops = app.get(SyncOpsService);
    materializer = app.get(SandboxCatalogueMaterializer);
    sandbox = app.get(QubeMockInventoryProvider);
    registry = app.get(InventoryProviderRegistry);
    router = app.get(BookingExecutionRouter);
    strategy = app.get(ProviderAuthoritativeStrategy);
    payments = app.get(PaymentsService);
    shows = app.get(ShowsService);

    sandbox.reset();
    await wipeProviderData();

    const org = await prisma.organization.create({
      data: { name: `Qube ${suffix}`, slug: `qube-${suffix}` },
    });
    orgId = org.id;
    operator = await makeUser('op', 'ORGANIZER_OWNER');
    buyer = await makeUser('buyer');
    buyerTwo = await makeUser('buyer2');
  }, 180_000);

  afterAll(async () => {
    if (available) {
      await wipeProviderData().catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
      await prisma.user
        .deleteMany({ where: { email: { endsWith: `${suffix}.test` } } })
        .catch(() => undefined);
    }
    await app?.close().catch(() => undefined);
    process.env = originalEnv;
  }, 120_000);

  /**
   * Remove everything this provider owns, in dependency order.
   *
   * Runs before as well as after: a previous crashed run leaving a half-imported catalogue
   * behind would make the first assertion here ("nothing existed, then sync created it") pass
   * or fail for reasons that have nothing to do with the code.
   */
  async function wipeProviderData(): Promise<void> {
    const mappings = await prisma.providerMapping.findMany({
      where: { providerCode: QUBE_MOCK_PROVIDER_CODE },
      select: { internalEntityType: true, internalEntityId: true },
    });
    const ids = (type: string) =>
      mappings
        .filter((m) => m.internalEntityType === type && m.internalEntityId)
        .map((m) => m.internalEntityId as string);

    const sessionIds = ids('eventSession');
    const screenIds = ids('screen');
    const cinemaIds = ids('cinema');
    const movieIds = ids('movie');

    const bookingIds = (
      await prisma.booking.findMany({
        where: { eventSessionId: { in: sessionIds } },
        select: { id: true },
      })
    ).map((b) => b.id);

    await deleteBookingsAndEverythingHangingOffThem(bookingIds);
    await prisma.showSeat.deleteMany({ where: { eventSessionId: { in: sessionIds } } });
    await prisma.ticketType.deleteMany({ where: { eventSessionId: { in: sessionIds } } });
    await prisma.eventSession.deleteMany({ where: { id: { in: sessionIds } } });
    await prisma.event.deleteMany({ where: { movieId: { in: movieIds } } });
    await prisma.seat.deleteMany({ where: { seatMap: { screenId: { in: screenIds } } } });
    await prisma.seatRow.deleteMany({
      where: { section: { seatMap: { screenId: { in: screenIds } } } },
    });
    await prisma.seatSection.deleteMany({ where: { seatMap: { screenId: { in: screenIds } } } });
    await prisma.seatCategory.deleteMany({ where: { seatMap: { screenId: { in: screenIds } } } });
    await prisma.seatMap.deleteMany({ where: { screenId: { in: screenIds } } });
    await prisma.screen.deleteMany({ where: { id: { in: screenIds } } });
    await prisma.movie.deleteMany({ where: { id: { in: movieIds } } });
    await prisma.cinema.deleteMany({ where: { id: { in: cinemaIds } } });
    await prisma.providerMapping.deleteMany({
      where: { providerCode: QUBE_MOCK_PROVIDER_CODE },
    });
    await prisma.rawProviderEvent.deleteMany({
      where: { providerCode: QUBE_MOCK_PROVIDER_CODE },
    });
    await prisma.providerSyncCheckpoint.deleteMany({
      where: { providerCode: QUBE_MOCK_PROVIDER_CODE },
    });
  }

  /**
   * A booking has a long tail — tickets and their check-ins, a payment and its attempts,
   * receipts (which reference each other) and refunds — and none of it cascades. Deleted in
   * dependency order rather than optimistically, so a cleanup failure does not leave the next
   * run reading a half-deleted catalogue and blaming the code for it.
   */
  async function deleteBookingsAndEverythingHangingOffThem(bookingIds: string[]): Promise<void> {
    if (bookingIds.length === 0) return;
    const where = { bookingId: { in: bookingIds } };
    const tickets = (await prisma.ticket.findMany({ where, select: { id: true } })).map(
      (t) => t.id,
    );
    const payments = (await prisma.payment.findMany({ where, select: { id: true } })).map(
      (p) => p.id,
    );

    await prisma.checkIn.deleteMany({ where: { ticketId: { in: tickets } } });
    await prisma.ticketInvite.deleteMany({ where: { ticketId: { in: tickets } } });
    await prisma.ticket.deleteMany({ where });
    // Receipts can reverse other receipts, so the reversals go first.
    await prisma.receipt.deleteMany({ where: { ...where, NOT: { reversesId: null } } });
    await prisma.receipt.deleteMany({ where });
    await prisma.refund.deleteMany({ where });
    await prisma.dispute.deleteMany({ where: { paymentId: { in: payments } } });
    await prisma.paymentAttempt.deleteMany({ where: { paymentId: { in: payments } } });
    await prisma.payment.deleteMany({ where });
    await prisma.bookingTaxLine.deleteMany({ where });
    await prisma.bookingItem.deleteMany({ where });
    await prisma.bookingWorkflow.deleteMany({ where });
    await prisma.showSeat.updateMany({
      where: { holdBookingId: { in: bookingIds } },
      data: { holdBookingId: null },
    });
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
  }

  async function makeUser(tag: string, role?: 'ORGANIZER_OWNER'): Promise<RequestUser> {
    const user = await prisma.user.create({
      data: {
        email: `${tag}-${suffix}@${suffix}.test`,
        fullName: `${tag} ${suffix}`,
        passwordHash: 'x',
      },
    });
    if (role) {
      await prisma.organizationMember.create({
        data: { userId: user.id, organizationId: orgId, role: role as never },
      });
    }
    return { id: user.id, email: user.email, fullName: user.fullName, roles: [] } as never;
  }

  /** One full sync cycle through the REAL infrastructure: poll → ingest → process → apply. */
  async function runSync(): Promise<void> {
    // Release the poll lease first: the durable checkpoint deliberately stops a second node
    // polling the same resource, and inside one test process we ARE the second node.
    await checkpoints
      .releaseLease(QUBE_MOCK_PROVIDER_CODE, TENANT, 'changes')
      .catch(() => undefined);
    await polling.poll(QUBE_MOCK_PROVIDER_CODE);
    // The queue has no worker in this process; the durable sweep is the same code path the
    // worker runs, and it is what makes the raw events become canonical changes.
    await processor.sweep(2000);
  }

  async function materialize() {
    return materializer.materialize({
      providerCode: QUBE_MOCK_PROVIDER_CODE,
      organizationId: orgId,
      actor: operator,
      pricingByCategory: OUR_PRICES,
    });
  }

  /** The 19:30 showing on Screen 1 — the one the mission names — as the provider sees it. */
  async function externalEveningShow(): Promise<string> {
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const shows = await sandbox.getShows({});
    const show = shows.find(
      (s) => local.format(s.startsAt) === '19:30' && s.screenExternalId.endsWith('-S1'),
    );
    return show!.externalId;
  }

  async function internalSessionFor(externalShowId: string): Promise<string> {
    const mapping = await prisma.providerMapping.findFirst({
      where: {
        providerCode: QUBE_MOCK_PROVIDER_CODE,
        externalEntityType: 'SESSION',
        externalEntityId: externalShowId,
      },
    });
    return mapping?.internalEntityId as string;
  }

  /** Seat F10 in a session, as the customer's seat map presents it. */
  async function pickF10(sessionId: string): Promise<{ seatId: string; ticketTypeId: string }> {
    const layout = (await shows.getPublicSeatLayout(sessionId)) as {
      categories: Array<{ id: string; ticketTypeId: string | null }>;
      sections: Array<{
        rows: Array<{
          label: string;
          seats: Array<{ id: string; label: string; categoryId: string }>;
        }>;
      }>;
    };
    for (const section of layout.sections) {
      for (const row of section.rows) {
        if (row.label !== 'F') continue;
        const seat = row.seats.find((s) => s.label === '10');
        if (!seat) continue;
        const category = layout.categories.find((c) => c.id === seat.categoryId);
        return { seatId: seat.id, ticketTypeId: category?.ticketTypeId as string };
      }
    }
    throw new Error('F10 not found in the imported layout');
  }

  /**
   * One purchase attempt, through the same router the HTTP controller calls.
   *
   * The idempotency key is explicit, as a real client's `Idempotency-Key` header is. Without
   * one the router derives `owner:session:ownerType`, which makes a second DIFFERENT purchase
   * in the same showing collide with the first — correct for a retry, wrong for a customer
   * coming back for another seat.
   */
  async function buy(
    user: RequestUser,
    sessionId: string,
    seatId: string,
    ticketTypeId: string,
  ): Promise<string> {
    const created = (await router.initiate({
      user,
      idempotencyKey: `${user.id}:${seatId}`,
      body: {
        eventSessionId: sessionId,
        items: [{ ticketTypeId, quantity: 1, seatIds: [seatId] }],
        buyerName: 'Test Buyer',
        buyerEmail: `${user.email}`,
      } as never,
    })) as { id: string };
    return created.id;
  }

  const maybe = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  // ── 1. sync ingests, and creates nothing sellable ────────────────────────────────

  maybe('sync records the provider catalogue and materializes NOTHING on its own', async () => {
    await runSync();

    const mappings = await prisma.providerMapping.findMany({
      where: { providerCode: QUBE_MOCK_PROVIDER_CODE },
    });
    const byType = (t: string) => mappings.filter((m) => m.externalEntityType === t);
    expect(byType('VENUE')).toHaveLength(1);
    expect(byType('SCREEN')).toHaveLength(3);
    expect(byType('EXPERIENCE')).toHaveLength(2);
    expect(byType('SESSION').length).toBeGreaterThan(0);

    /*
      The governance guarantee, asserted rather than described. Ingestion ends at UNMAPPED.
      If this ever fails, a vendor feed has become able to publish, and every other assertion
      in this file is beside the point.
    */
    expect(mappings.every((m) => m.status === 'UNMAPPED')).toBe(true);
    expect(mappings.every((m) => m.internalEntityId === null)).toBe(true);
    expect(await prisma.cinema.count({ where: { organizationId: orgId } })).toBe(0);
    expect(await prisma.movie.count({ where: { organizationId: orgId } })).toBe(0);
  });

  // ── 2. sandbox materialization, and its idempotence ──────────────────────────────

  maybe('the sandbox materializer turns the mapped catalogue into a sellable cinema', async () => {
    const report = await materialize();

    expect(report.cinemas.created).toBe(1);
    expect(report.screens.created).toBe(3);
    expect(report.movies.created).toBe(2);
    expect(report.shows.created).toBeGreaterThan(0);
    // Nothing quietly dropped: whatever the platform refused is named.
    expect(report.skipped).toEqual([]);

    const mappings = await prisma.providerMapping.findMany({
      where: {
        providerCode: QUBE_MOCK_PROVIDER_CODE,
        externalEntityType: { in: ['VENUE', 'SCREEN', 'EXPERIENCE', 'SESSION'] },
      },
    });
    expect(mappings.every((m) => m.status === 'ACTIVE' && m.internalEntityId)).toBe(true);
  });

  maybe('a second sync and a second materialization create nothing at all', async () => {
    const before = {
      cinemas: await prisma.cinema.count({ where: { organizationId: orgId } }),
      screens: await prisma.screen.count({ where: { cinema: { organizationId: orgId } } }),
      movies: await prisma.movie.count({ where: { organizationId: orgId } }),
      sessions: await prisma.eventSession.count({ where: { event: { organizationId: orgId } } }),
      seatMaps: await prisma.seatMap.count({
        where: { screen: { cinema: { organizationId: orgId } } },
      }),
    };

    await runSync();
    const report = await materialize();

    expect(report.cinemas.created).toBe(0);
    expect(report.screens.created).toBe(0);
    expect(report.movies.created).toBe(0);
    expect(report.shows.created).toBe(0);
    expect(report.shows.rescheduled).toBe(0);

    expect(await prisma.cinema.count({ where: { organizationId: orgId } })).toBe(before.cinemas);
    expect(await prisma.screen.count({ where: { cinema: { organizationId: orgId } } })).toBe(
      before.screens,
    );
    expect(await prisma.movie.count({ where: { organizationId: orgId } })).toBe(before.movies);
    expect(await prisma.eventSession.count({ where: { event: { organizationId: orgId } } })).toBe(
      before.sessions,
    );
    expect(
      await prisma.seatMap.count({ where: { screen: { cinema: { organizationId: orgId } } } }),
    ).toBe(before.seatMaps);
  });

  maybe('a moved showtime moves the SAME show — it never creates a second one', async () => {
    const externalShow = await externalEveningShow();
    const sessionId = await internalSessionFor(externalShow);
    const before = await prisma.eventSession.findUnique({ where: { id: sessionId } });
    const totalBefore = await prisma.eventSession.count({
      where: { event: { organizationId: orgId } },
    });

    // 19:30 → 20:00 at the exhibitor. The external id does NOT change, which is the whole
    // point: identity is the id, never the time, the title or the position in a list.
    const moved = new Date(before!.startsAt.getTime() + 30 * 60_000);
    sandbox.rescheduleShow(externalShow, moved);

    await runSync();
    const report = await materialize();

    expect(report.shows.created).toBe(0);
    expect(report.shows.rescheduled).toBe(1);
    expect(await prisma.eventSession.count({ where: { event: { organizationId: orgId } } })).toBe(
      totalBefore,
    );

    const after = await prisma.eventSession.findUnique({ where: { id: sessionId } });
    expect(after!.id).toBe(sessionId);
    expect(after!.startsAt.toISOString()).toBe(moved.toISOString());
    // And the mapping still names the same external show at a higher version.
    const mapping = await prisma.providerMapping.findFirst({
      where: {
        providerCode: QUBE_MOCK_PROVIDER_CODE,
        externalEntityType: 'SESSION',
        externalEntityId: externalShow,
      },
    });
    expect(mapping!.internalEntityId).toBe(sessionId);
    expect(mapping!.externalVersion).toBe(2);
  });

  maybe('the imported prices are OURS, never the ones the vendor published', async () => {
    const externalShow = await externalEveningShow();
    const sessionId = await internalSessionFor(externalShow);
    const types = await prisma.ticketType.findMany({ where: { eventSessionId: sessionId } });

    expect(types.length).toBe(4);
    for (const t of types) {
      expect(Object.values(OUR_PRICES)).toContain(t.priceMinor);
      expect(VENDOR_PRICES).not.toContain(t.priceMinor);
    }
  });

  // ── 3. the purchase ──────────────────────────────────────────────────────────────

  maybe('a customer buys F10 end to end and gets a QR ticket', async () => {
    const externalShow = await externalEveningShow();
    const sessionId = await internalSessionFor(externalShow);
    const { seatId, ticketTypeId } = await pickF10(sessionId);

    // "The local provider never sells F10", asked of the local provider itself rather than
    // inferred from a workflow column.
    const direct = registry.get('direct')!;
    const localLock = jest.spyOn(direct, 'lockInventory');
    const localConfirm = jest.spyOn(direct, 'confirmBooking');

    const bookingId = await buy(buyer, sessionId, seatId, ticketTypeId);
    await router.beginPayment({ user: buyer, bookingId });
    await payments.mockPay(bookingId, 'succeeded');

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true, tickets: true },
    });
    expect(booking!.status).toBe('CONFIRMED');
    expect(booking!.tickets).toHaveLength(1);
    // The QR is derived from these two; a ticket without them cannot be scanned.
    expect(booking!.tickets[0].serial).toBeTruthy();
    expect(booking!.tickets[0].nonce).toBeTruthy();
    expect(booking!.tickets[0].seatId).toBe(seatId);
    expect(booking!.payment?.status).toBe('SUCCEEDED');

    // Exactly one booking and one payment for this seat — not "at least one".
    expect(await prisma.booking.count({ where: { eventSessionId: sessionId } })).toBe(1);
    expect(await prisma.payment.count({ where: { bookingId } })).toBe(1);

    const workflow = await prisma.bookingWorkflow.findFirst({ where: { bookingId } });
    expect(workflow!.selectedProviderCode).toBe(QUBE_MOCK_PROVIDER_CODE);
    expect(workflow!.inventoryOwnershipMode).toBe('PROVIDER_AUTHORITATIVE');

    expect(localLock).not.toHaveBeenCalled();
    expect(localConfirm).not.toHaveBeenCalled();
    localLock.mockRestore();
    localConfirm.mockRestore();

    // The seat is gone at the REMOTE authority, which is the only place that decides.
    const map = await sandbox.getSeatMap(externalShow);
    expect(map.seats.find((s) => s.label === 'F10')!.state).toBe('SOLD');
  });

  // ── 4. two customers, one seat ───────────────────────────────────────────────────

  maybe('two customers racing for one seat produce exactly one booking', async () => {
    const externalShow = await externalEveningShow();
    const sessionId = await internalSessionFor(externalShow);
    const layout = await pickSeat(sessionId, 'E', '7');

    const results = await Promise.allSettled([
      buy(buyer, sessionId, layout.seatId, layout.ticketTypeId),
      buy(buyerTwo, sessionId, layout.seatId, layout.ticketTypeId),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser is told the seat is TAKEN, not that something went wrong. A conflict and a
    // failure are different facts and lead to different next actions.
    const reason = (lost[0] as PromiseRejectedResult).reason as { code?: string; status?: number };
    expect([409, 400]).toContain(reason.status ?? 409);

    // Counted at the seat, not at the booking: exactly one ticket may ever name this seat.
    const held = await prisma.showSeat.findFirst({
      where: { eventSessionId: sessionId, seatId: layout.seatId },
    });
    expect(['HELD', 'SOLD']).toContain(held!.status);

    const map = await sandbox.getSeatMap(externalShow);
    const seat = map.seats.find((s) => s.label === 'E7')!;
    expect(['HELD', 'SOLD']).toContain(seat.state);
  });

  async function pickSeat(
    sessionId: string,
    rowLabel: string,
    seatLabel: string,
  ): Promise<{ seatId: string; ticketTypeId: string }> {
    const layout = (await shows.getPublicSeatLayout(sessionId)) as {
      categories: Array<{ id: string; ticketTypeId: string | null }>;
      sections: Array<{
        rows: Array<{
          label: string;
          seats: Array<{ id: string; label: string; categoryId: string }>;
        }>;
      }>;
    };
    for (const section of layout.sections) {
      for (const row of section.rows) {
        if (row.label !== rowLabel) continue;
        const seat = row.seats.find((s) => s.label === seatLabel);
        if (!seat) continue;
        const category = layout.categories.find((c) => c.id === seat.categoryId);
        return { seatId: seat.id, ticketTypeId: category?.ticketTypeId as string };
      }
    }
    throw new Error(`${rowLabel}${seatLabel} not found`);
  }

  // ── 5. payment failure ───────────────────────────────────────────────────────────

  maybe('a failed payment releases the remote seat and issues no ticket', async () => {
    const externalShow = await externalEveningShow();
    const sessionId = await internalSessionFor(externalShow);
    const { seatId, ticketTypeId } = await pickSeat(sessionId, 'D', '3');

    const bookingId = await buy(buyer, sessionId, seatId, ticketTypeId);
    await router.beginPayment({ user: buyer, bookingId });
    await payments.mockPay(bookingId, 'failed');

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { tickets: true },
    });
    expect(booking!.status).not.toBe('CONFIRMED');
    expect(booking!.tickets).toHaveLength(0);

    // Cancel the reservation the way the compensation path does, then check the venue.
    await strategy.cancelReservation(bookingId).catch(() => undefined);
    const map = await sandbox.getSeatMap(externalShow);
    expect(map.seats.find((s) => s.label === 'D3')!.state).toBe('AVAILABLE');
  });

  // ── 6. ambiguous confirmation ────────────────────────────────────────────────────

  maybe(
    'a confirmation that times out AFTER the venue committed resolves to CONFIRMED',
    async () => {
      const externalShow = await externalEveningShow();
      const sessionId = await internalSessionFor(externalShow);
      const { seatId, ticketTypeId } = await pickSeat(sessionId, 'D', '5');

      const bookingId = await buy(buyer, sessionId, seatId, ticketTypeId);
      await router.beginPayment({ user: buyer, bookingId });

      // The dangerous case: the venue DID take the booking and the answer was lost.
      sandbox.setOutage('commit_then_timeout');
      await payments.mockPay(bookingId, 'succeeded').catch(() => undefined);
      sandbox.setOutage('none');

      const mid = await prisma.bookingWorkflow.findFirst({ where: { bookingId } });
      // Not rejected, not refunded, not retried into a second booking — flagged as unknown.
      expect(mid!.providerReconciliationRequired).toBe(true);
      expect(await prisma.ticket.count({ where: { bookingId } })).toBe(0);

      const recovery = await strategy.recoverStatus(bookingId);
      // The recovery vocabulary is deliberately narrower than "confirmed": the PROVIDER is
      // confirmed, and the local confirmation is what happens next. Conflating the two is how
      // a ticket gets issued for a booking the venue never took.
      expect(recovery.classification).toBe('PROVIDER_CONFIRMED_LOCAL_PENDING');

      const after = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { tickets: true, payment: true },
      });
      expect(after!.status).toBe('CONFIRMED');
      expect(after!.tickets).toHaveLength(1);
      // One payment, one ticket, one booking at the venue: no duplicate anything.
      expect(await prisma.payment.count({ where: { bookingId } })).toBe(1);
    },
  );

  maybe('a confirmation that times out because it NEVER arrived does not confirm', async () => {
    const externalShow = await externalEveningShow();
    const sessionId = await internalSessionFor(externalShow);
    const { seatId, ticketTypeId } = await pickSeat(sessionId, 'D', '6');

    const bookingId = await buy(buyer, sessionId, seatId, ticketTypeId);
    await router.beginPayment({ user: buyer, bookingId });

    sandbox.setOutage('timeout');
    await payments.mockPay(bookingId, 'succeeded').catch(() => undefined);
    sandbox.setOutage('none');

    const recovery = await strategy.recoverStatus(bookingId);
    // The venue has no record. Confirming would invent a booking; the platform says so and
    // leaves it for a human rather than guessing in either direction.
    expect(recovery.classification).not.toBe('CONFIRMED');
    expect(await prisma.ticket.count({ where: { bookingId } })).toBe(0);
    const seatState = (await sandbox.getSeatMap(externalShow)).seats.find(
      (s) => s.label === 'D6',
    )!.state;
    expect(seatState).not.toBe('SOLD');
  });

  // ── 7. outage ────────────────────────────────────────────────────────────────────

  maybe('an outage fails the sale and never reaches local inventory', async () => {
    const externalShow = await externalEveningShow();
    const sessionId = await internalSessionFor(externalShow);
    const { seatId, ticketTypeId } = await pickSeat(sessionId, 'B', '4');

    const direct = registry.get('direct')!;
    const localLock = jest.spyOn(direct, 'lockInventory');
    const ticketsBefore = await prisma.ticket.count({
      where: { booking: { eventSessionId: sessionId } },
    });

    sandbox.setOutage('unavailable');
    await expect(buy(buyer, sessionId, seatId, ticketTypeId)).rejects.toBeDefined();
    sandbox.setOutage('none');

    // The rule that matters: these seats belong to an exhibitor. An outage must fail the
    // sale, not relocate it to stock we happen to have.
    expect(localLock).not.toHaveBeenCalled();
    localLock.mockRestore();
    // Counted as a delta, not against a number written down when this test was authored:
    // a hard-coded total silently becomes an assertion about the tests that ran before it.
    expect(await prisma.ticket.count({ where: { booking: { eventSessionId: sessionId } } })).toBe(
      ticketsBefore,
    );
  });

  // ── 8. the production path is still closed ───────────────────────────────────────

  maybe(
    'the review queue lists what an operator would have to approve for a real provider',
    async () => {
      // Same table, same statuses, same operation — the sandbox just has no human in it.
      const queue = await ops.listMappings({ providerCode: QUBE_MOCK_PROVIDER_CODE });
      expect(queue).toEqual([]); // everything here has been approved by the materializer

      const approved = await ops.listMappings({
        providerCode: QUBE_MOCK_PROVIDER_CODE,
        status: 'ACTIVE',
        externalEntityType: 'SESSION',
        limit: 5,
      });
      expect(approved.length).toBeGreaterThan(0);
      expect(approved[0].internalEntityType).toBe('eventSession');
    },
  );

  maybe('an operator cannot approve a link to something that does not exist', async () => {
    const mapping = await prisma.providerMapping.findFirst({
      where: { providerCode: QUBE_MOCK_PROVIDER_CODE, externalEntityType: 'SESSION' },
    });
    await expect(
      ops.resolveMapping(null, mapping!.id, 'eventSession', 'no-such-session'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      ops.resolveMapping(null, mapping!.id, 'organization', mapping!.id),
    ).rejects.toMatchObject({ status: 400 });
  });
});
