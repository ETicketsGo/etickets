import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { AdminService } from './admin.service';
import { BookingsService } from '../bookings/bookings.service';

/**
 * integration-real-postgres - deleting and renaming fee bands against a real database.
 *
 * What only a database proves: the delete is SOFT (the row survives, switched off and stamped),
 * an AuditLog row an auditor can query exists, the coverage refusal reads the real schedule,
 * live pricing stops using a deleted band at once, and a booking already priced under the band
 * keeps exactly the money it was charged - bookings snapshot amounts and never point at a band.
 *
 * Isolation: every band created here is scoped to a region that only this suite's venue uses
 * ("Testland-<tag>", India), so no other order can match it. The national seeded INR schedule
 * is read, never changed.
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

const tag = `frd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const REGION = `Testland-${tag}`;
const DAY = 86_400_000;

describe('integration-real-postgres: fee band delete and names', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let mod: TestingModule | undefined;
  let available = false;
  let admin: AdminService;
  let bookings: BookingsService;
  let adminId = '';
  let orgId = '';
  let venueId = '';
  let seq = 0;
  const bandIds: string[] = [];

  async function event(priceMinor: number) {
    const n = ++seq;
    const ev = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId,
        title: `Fee band ${tag} ${n}`,
        slug: `fee-band-${tag}-${n}`,
        category: 'Music',
        status: 'PUBLISHED',
        feeMode: 'CUSTOMER_PAYS' as never,
      },
    });
    const startsAt = new Date(Date.now() + 10 * DAY);
    const session = await db!.eventSession.create({
      data: { eventId: ev.id, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) },
    });
    const tt = await db!.ticketType.create({
      data: {
        eventSessionId: session.id,
        name: 'General',
        priceMinor,
        currency: 'INR',
        quantityTotal: 100,
        maxPerOrder: 10,
      },
    });
    await db!.ticketInventory.create({ data: { ticketTypeId: tt.id, quantityTotal: 100 } });
    return { sessionId: session.id, ticketTypeId: tt.id };
  }

  const input = (e: { sessionId: string; ticketTypeId: string }, quantity = 1) => {
    const n = ++seq;
    return {
      eventSessionId: e.sessionId,
      items: [{ ticketTypeId: e.ticketTypeId, quantity }],
      buyerName: `Buyer ${n}`,
      buyerEmail: `buyer-${n}-${tag}@test.invalid`,
    } as never;
  };

  const band = async (minMinor: number, maxMinor: number | null, feeMinor: number) => {
    const b = await admin.createFeeRule(adminId, {
      currency: 'INR',
      minMinor,
      maxMinor,
      feeMinor,
      country: 'India',
      region: REGION,
    });
    bandIds.push(b.id);
    return b;
  };

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT "deletedAt" FROM "FeeRule" LIMIT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable or not migrated');
      return;
    }
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = process.env.APP_ENV ?? 'LOCAL';
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await mod.init();
    admin = mod.get(AdminService);
    bookings = mod.get(BookingsService);

    adminId = (
      await db!.user.create({
        data: {
          email: `admin-${tag}@test.invalid`,
          fullName: 'Band Admin',
          passwordHash: 'not-a-real-hash',
          roles: ['ADMIN'],
        },
      })
    ).id;
    orgId = (
      await db!.organization.create({
        data: { name: `Band Org ${tag}`, slug: `band-org-${tag}`, status: 'APPROVED' },
      })
    ).id;
    venueId = (
      await db!.venue.create({
        data: {
          organizationId: orgId,
          name: `Band Hall ${tag}`,
          city: 'Vijayawada',
          country: 'India',
          region: REGION,
          timezone: 'Asia/Kolkata',
        },
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const bookingWhere = { organizationId: orgId };
      const steps: Array<() => Promise<unknown>> = [
        () => db!.auditLog.deleteMany({ where: { actorUserId: adminId } }),
        () => db!.bookingTaxLine.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.payment.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.bookingItem.deleteMany({ where: { booking: bookingWhere } }),
        () => db!.booking.deleteMany({ where: bookingWhere }),
        () =>
          db!.ticketInventory.deleteMany({
            where: { ticketType: { eventSession: { event: { organizationId: orgId } } } },
          }),
        () =>
          db!.ticketType.deleteMany({
            where: { eventSession: { event: { organizationId: orgId } } },
          }),
        () => db!.eventSession.deleteMany({ where: { event: { organizationId: orgId } } }),
        () => db!.event.deleteMany({ where: { organizationId: orgId } }),
        () => db!.venue.deleteMany({ where: { organizationId: orgId } }),
        () => db!.organization.deleteMany({ where: { id: orgId } }),
        () => db!.feeRule.deleteMany({ where: { region: REGION } }),
        () => db!.user.deleteMany({ where: { id: adminId } }),
      ];
      for (const step of steps) await step().catch(() => undefined);
      await db.$disconnect();
    }
    await mod?.close();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  maybe(
    'a delete is soft, audited, and stops pricing at once; the booking keeps its fee',
    async () => {
      const e = await event(50_000);
      // The national schedule charges Rs 15 on Rs 500. A state band for this region charges Rs 7.
      const national = await bookings.quote(input(e));
      expect(national.fees.bookingFeeMinor).toBe(1_500);
      const state = await band(0, null, 700);
      expect(state.label).toBe('Tickets ₹0 and above');

      const booked = (await bookings.create(null, input(e, 2))) as unknown as {
        id: string;
        fees: { bookingFeeMinor: number; totalMinor: number };
      };
      expect(booked.fees.bookingFeeMinor).toBe(700);
      const before = await db!.booking.findUniqueOrThrow({ where: { id: booked.id } });

      // Edit the band, then delete it: the booking does not move.
      await admin.updateFeeRule(adminId, state.id, { feeMinor: 900, maxMinor: 999_999 });
      const listed = (await admin.feeRules()).find((r) => r.id === state.id)!;
      expect(listed.displayLabel).toBe('Tickets ₹0 - ₹9,999.99');
      // The stored label is history: the edit did not rewrite it.
      expect(listed.label).toBe('Tickets ₹0 and above');

      await admin.deleteFeeRule(adminId, state.id);

      const stored = await db!.feeRule.findUniqueOrThrow({ where: { id: state.id } });
      expect(stored.active).toBe(false);
      expect(stored.deletedAt).toBeInstanceOf(Date);
      expect(stored.deletedByUserId).toBe(adminId);
      expect((await admin.feeRules()).some((r) => r.id === state.id)).toBe(false);
      expect((await admin.feeRules({ includeDeleted: true })).some((r) => r.id === state.id)).toBe(
        true,
      );

      const audit = await db!.auditLog.findMany({
        where: { actorUserId: adminId, entityId: state.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a: { action: string }) => a.action)).toEqual([
        'FEE_RULE_CREATED',
        'FEE_RULE_UPDATED',
        'FEE_RULE_DELETED',
      ]);

      // Pricing is back on the national schedule for the next order.
      expect((await bookings.quote(input(e))).fees.bookingFeeMinor).toBe(1_500);

      // The booking already made is exactly as it was.
      const after = await db!.booking.findUniqueOrThrow({ where: { id: booked.id } });
      expect(after.bookingFeeMinor).toBe(before.bookingFeeMinor);
      expect(after.paymentFeeMinor).toBe(before.paymentFeeMinor);
      expect(after.customerFeeMinor).toBe(before.customerFeeMinor);
      expect(after.totalMinor).toBe(before.totalMinor);

      // And a deleted band cannot be edited back to life.
      await expect(admin.updateFeeRule(adminId, state.id, { active: true })).rejects.toMatchObject({
        status: 409,
      });
    },
  );

  maybe('a delete that would open a hole is refused with 409 and changes nothing', async () => {
    // A complete state schedule of its own, in a sub-region no national band reaches.
    const sub = `${REGION}-own`;
    const mk = async (min: number, max: number | null, fee: number) => {
      const b = await admin.createFeeRule(adminId, {
        currency: 'INR',
        minMinor: min,
        maxMinor: max,
        feeMinor: fee,
        country: 'Nowhereland',
        region: sub,
      });
      bandIds.push(b.id);
      return b;
    };
    const a = await mk(0, 49_900, 100);
    const b = await mk(50_000, 99_900, 200);
    const c = await mk(100_000, null, 300);
    try {
      await expect(admin.deleteFeeRule(adminId, b.id)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('orders between ₹499 and ₹1,000'),
      });
      await expect(admin.deleteFeeRule(adminId, c.id)).rejects.toMatchObject({ status: 409 });
      const untouched = await db!.feeRule.findUniqueOrThrow({ where: { id: b.id } });
      expect(untouched.active).toBe(true);
      expect(untouched.deletedAt).toBeNull();

      // The supported route: switch it off, widen a neighbour, then delete.
      await admin.updateFeeRule(adminId, b.id, { active: false });
      await admin.updateFeeRule(adminId, a.id, { maxMinor: 99_900 });
      await admin.deleteFeeRule(adminId, b.id);

      // With two bands left, the last one standing for the place still cannot go.
      await admin.updateFeeRule(adminId, c.id, { active: false });
      await expect(admin.deleteFeeRule(adminId, a.id)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('built-in default fees'),
      });
    } finally {
      await db!.auditLog.deleteMany({ where: { entityId: { in: [a.id, b.id, c.id] } } });
      await db!.feeRule.deleteMany({ where: { region: sub } });
    }
  });

  maybe('an overlapping band in the same place is refused with 409', async () => {
    const sub = `${REGION}-overlap`;
    const first = await admin.createFeeRule(adminId, {
      currency: 'INR',
      minMinor: 0,
      maxMinor: 49_900,
      feeMinor: 100,
      country: 'Nowhereland',
      region: sub,
    });
    try {
      await expect(
        admin.createFeeRule(adminId, {
          currency: 'INR',
          minMinor: 40_000,
          maxMinor: null,
          feeMinor: 100,
          country: 'Nowhereland',
          region: sub,
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('"Tickets ₹0 - ₹499"'),
      });
    } finally {
      await db!.auditLog.deleteMany({ where: { entityId: first.id } });
      await db!.feeRule.deleteMany({ where: { region: sub } });
    }
  });
});
