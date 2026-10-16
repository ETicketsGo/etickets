import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { CancellationRefundsService } from '../refunds/cancellation-refunds.service';

/**
 * integration-real-postgres - running an event on the day, over HTTP against the whole app.
 *
 * Three things an organizer could not do, each proven end to end through the real booking,
 * payment, refund and pricing code rather than a stand-in:
 *
 * 1. Sell at the counter to somebody standing there: the tickets are issued at once, the stock
 *    is sold, the cash is recorded against the seller, and nothing reaches a payout. It does
 *    NOT need "pay at the venue" switched on for online buyers - and that switch still guards
 *    the online path exactly as before.
 * 2. Cancel a whole event that has paid bookings: sales stop, its dates are cancelled through
 *    the show cancellation, and a refund opens for the paid booking.
 * 3. Before an event exists, say which seat categories on a cinema screen need a class - and
 *    say nothing about classes where no price rule covers the place.
 *
 * Every row is created under a unique suffix and removed afterwards; the one pricing rule is
 * in a made-up country, so no real jurisdiction is ever switched on. Skips (never fabricates a
 * pass) when no database is reachable.
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

const PASSWORD = 'Vermilion-Lantern-4821!';

describe('integration-real-postgres: counter sales, event cancellation, seat classes', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;

  const suffix = `evops-${Date.now()}`;
  const country = `Testland ${suffix}`;
  const orgIds: string[] = [];
  let orgId = '';
  let otherOrgId = '';
  let otherSessionId = '';
  let ownerToken = '';
  let managerToken = '';
  let customerToken = '';
  let ownerId = '';
  let policyId = '';

  async function http(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json: json?.data ?? json };
  }

  const login = async (email: string) => {
    const r = await http('POST', '/auth/login', undefined, { email, password: PASSWORD });
    expect(r.status).toBeLessThan(300);
    return r.json.accessToken as string;
  };

  /** A published GA event with one future date and one ticket type, at `org`. */
  async function gaEvent(org: string, label: string, priceMinor = 50_000) {
    const venue = await db!.venue.create({
      data: { organizationId: org, name: `Hall ${label}`, city: 'Bengaluru', country: 'India' },
    });
    const event = await db!.event.create({
      data: {
        organizationId: org,
        venueId: venue.id,
        title: `Show ${label} ${suffix}`,
        slug: `show-${label.toLowerCase()}-${suffix}`,
        category: 'MUSIC',
        status: 'PUBLISHED',
      },
    });
    const startsAt = new Date(Date.now() + 5 * 86_400_000);
    const session = await db!.eventSession.create({
      data: { eventId: event.id, startsAt, endsAt: new Date(startsAt.getTime() + 7_200_000) },
    });
    const tt = await db!.ticketType.create({
      data: {
        eventSessionId: session.id,
        name: 'General',
        priceMinor,
        currency: 'INR',
        quantityTotal: 100,
        inventory: { create: { quantityTotal: 100 } },
      },
    });
    return { venueId: venue.id, eventId: event.id, sessionId: session.id, ticketTypeId: tt.id };
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- DB unavailable');
      return;
    }
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = process.env.APP_ENV ?? 'LOCAL';
    process.env.THROTTLE_LIMIT = '5000';
    process.env.AUTH_THROTTLE_LIMIT = '5000';

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const hash = await bcrypt.hash(PASSWORD, 10);
    const user = (who: string, role: string) =>
      db!.user.create({
        data: {
          email: `${who}-${suffix}@test.invalid`,
          passwordHash: hash,
          fullName: `${who} person`,
          roles: [role],
        },
      });
    const owner = await user('owner', 'ORGANIZER_OWNER');
    ownerId = owner.id;
    const manager = await user('manager', 'ORGANIZER_MANAGER');
    await user('cust', 'CUSTOMER');

    for (const k of ['A', 'B']) {
      const org = await db!.organization.create({
        data: {
          name: `Ops ${k} ${suffix}`,
          slug: `ops-${k.toLowerCase()}-${suffix}`,
          status: 'APPROVED',
          // Online buyers may NOT reserve and pay at the venue. The counter must not need it.
          cashPaymentsEnabled: false,
          contactEmail: `box-office-${k.toLowerCase()}-${suffix}@test.invalid`,
        },
      });
      orgIds.push(org.id);
    }
    [orgId, otherOrgId] = orgIds;
    await db!.organizationMember.createMany({
      data: [
        { organizationId: orgId, userId: owner.id, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
        { organizationId: orgId, userId: manager.id, role: 'ORGANIZER_MANAGER', status: 'ACTIVE' },
      ],
    });
    otherSessionId = (await gaEvent(otherOrgId, 'Other')).sessionId;

    ownerToken = await login(`owner-${suffix}@test.invalid`);
    managerToken = await login(`manager-${suffix}@test.invalid`);
    customerToken = await login(`cust-${suffix}@test.invalid`);
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const users = await db.user.findMany({
        where: { email: { contains: suffix } },
        select: { id: true },
      });
      const ids = users.map((u: { id: string }) => u.id);
      const where = { booking: { organizationId: { in: orgIds } } };
      await db.notification
        .deleteMany({ where: { OR: [{ userId: { in: ids } }, where] } })
        .catch(() => undefined);
      await db.receipt.deleteMany({ where }).catch(() => undefined);
      await db.refund.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.ticket.deleteMany({ where });
      await db.bookingItem.deleteMany({ where });
      await db.payment.deleteMany({ where });
      await db.booking.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.auditLog.deleteMany({
        where: { OR: [{ organizationId: { in: orgIds } }, { actorUserId: { in: ids } }] },
      });
      await db.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      const events = { event: { organizationId: { in: orgIds } } };
      await db.ticketInventory.deleteMany({ where: { ticketType: { eventSession: events } } });
      await db.ticketType.deleteMany({ where: { eventSession: events } });
      await db.eventSession.deleteMany({ where: events });
      await db.event.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.seatCategory.deleteMany({
        where: { seatMap: { screen: { venue: { organizationId: { in: orgIds } } } } },
      });
      await db.seatMap.deleteMany({
        where: { screen: { venue: { organizationId: { in: orgIds } } } },
      });
      await db.screen.deleteMany({ where: { venue: { organizationId: { in: orgIds } } } });
      await db.cinema.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.venue.deleteMany({ where: { organizationId: { in: orgIds } } });
      if (policyId) await db.cinemaPricingPolicy.deleteMany({ where: { id: policyId } });
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
    if (app) await app.close();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  // ── 1. The counter ─────────────────────────────────────────────────────────────────

  maybe(
    'sells at the counter for cash: tickets issued at once, stock sold, seller recorded',
    async () => {
      const show = await gaEvent(orgId, 'Counter');
      const r = await http('POST', `/organizations/${orgId}/counter-sales`, ownerToken, {
        eventSessionId: show.sessionId,
        items: [{ ticketTypeId: show.ticketTypeId, quantity: 2 }],
        buyerName: 'Walk Up Buyer',
      });
      expect(r.status).toBe(201);
      expect(r.json.status).toBe('CONFIRMED');
      expect(r.json.ticketCount).toBe(2);
      expect(r.json.reference).toBeTruthy();
      // No email given: the confirmation goes to the organization's own address, never nowhere.
      expect(r.json.emailedTo).toBe(`box-office-a-${suffix}@test.invalid`);

      const booking = await db!.booking.findUniqueOrThrow({
        where: { id: r.json.bookingId },
        include: { payment: true, tickets: true },
      });
      expect(booking.paymentMethod).toBe('CASH');
      expect(booking.cashCollectedByUserId).toBe(ownerId);
      expect(booking.cashCollectedAt).not.toBeNull();
      // Cash never passes through the platform: no Payment row, so nothing for a payout.
      expect(booking.payment).toBeNull();
      expect(booking.tickets.every((t: { status: string }) => t.status === 'ACTIVE')).toBe(true);
      const inv = await db!.ticketInventory.findUniqueOrThrow({
        where: { ticketTypeId: show.ticketTypeId },
      });
      expect(inv.quantitySold).toBe(2);
      expect(inv.quantityHeld).toBe(0);
    },
  );

  maybe(
    'leaves the online "pay at the venue" switch guarding the online path as before',
    async () => {
      const show = await gaEvent(orgId, 'Online');
      const r = await http('POST', '/bookings', customerToken, {
        eventSessionId: show.sessionId,
        items: [{ ticketTypeId: show.ticketTypeId, quantity: 1 }],
        buyerName: 'Online Buyer',
        buyerEmail: `cust-${suffix}@test.invalid`,
        paymentMethod: 'CASH',
      });
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.json)).toContain('does not accept cash at the venue');
    },
  );

  maybe('refuses a counter sale to anybody who is not staff of that organization', async () => {
    const show = await gaEvent(orgId, 'Refused');
    const body = {
      eventSessionId: show.sessionId,
      items: [{ ticketTypeId: show.ticketTypeId, quantity: 1 }],
      buyerName: 'Somebody',
    };
    expect(
      (await http('POST', `/organizations/${orgId}/counter-sales`, customerToken, body)).status,
    ).toBe(403);
    // Staff of A cannot sell B's show by naming their own organization.
    const cross = await http('POST', `/organizations/${orgId}/counter-sales`, ownerToken, {
      ...body,
      eventSessionId: otherSessionId,
    });
    expect(cross.status).toBe(404);
    // Nothing was held by either refusal.
    const inv = await db!.ticketInventory.findUniqueOrThrow({
      where: { ticketTypeId: show.ticketTypeId },
    });
    expect(inv.quantityHeld + inv.quantitySold).toBe(0);
  });

  maybe('cannot sell more than is left, and holds nothing when it refuses', async () => {
    const show = await gaEvent(orgId, 'Full');
    await db!.ticketInventory.update({
      where: { ticketTypeId: show.ticketTypeId },
      data: { quantitySold: 99 },
    });
    const r = await http('POST', `/organizations/${orgId}/counter-sales`, ownerToken, {
      eventSessionId: show.sessionId,
      items: [{ ticketTypeId: show.ticketTypeId, quantity: 2 }],
      buyerName: 'Too Many',
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const inv = await db!.ticketInventory.findUniqueOrThrow({
      where: { ticketTypeId: show.ticketTypeId },
    });
    expect(inv.quantitySold).toBe(99);
    expect(inv.quantityHeld).toBe(0);
  });

  // ── 2. Cancelling an event ─────────────────────────────────────────────────────────

  maybe(
    'cancels a whole event with a paid booking: sales stop, dates cancelled, refund opened',
    async () => {
      const show = await gaEvent(orgId, 'Cancel');
      const booking = await db!.booking.create({
        data: {
          organizationId: orgId,
          eventId: show.eventId,
          eventSessionId: show.sessionId,
          status: 'CONFIRMED',
          buyerName: 'Paid Buyer',
          buyerEmail: `cust-${suffix}@test.invalid`,
          currency: 'INR',
          subtotalMinor: 50_000,
          totalMinor: 50_000,
          confirmedAt: new Date(),
          holdExpiresAt: new Date(Date.now() + 3_600_000),
          reference: `EVOPS-${suffix}`,
          items: {
            create: [
              {
                kind: 'TICKET',
                ticketTypeId: show.ticketTypeId,
                quantity: 1,
                unitPriceMinor: 50_000,
                lineTotalMinor: 50_000,
              },
            ],
          },
          payment: {
            create: {
              provider: 'mock',
              status: 'SUCCEEDED',
              amountMinor: 50_000,
              currency: 'INR',
              providerRef: `pay_${suffix}`,
            },
          },
        },
      });
      await db!.ticket.create({
        data: {
          bookingId: booking.id,
          ticketTypeId: show.ticketTypeId,
          eventSessionId: show.sessionId,
          organizationId: orgId,
          serial: `TKT-EVOPS-${suffix}`,
          nonce: `n-evops-${suffix}`,
          status: 'ACTIVE',
          holderName: 'Paid Buyer',
        },
      });

      // A manager may cancel a date, but not refund everybody at once.
      const asManager = await http('POST', `/events/${show.eventId}/cancel`, managerToken, {
        reason: 'The band cannot travel.',
      });
      expect(asManager.status).toBe(403);

      const r = await http('POST', `/events/${show.eventId}/cancel`, ownerToken, {
        reason: 'The band cannot travel.',
      });
      expect(r.status).toBe(201);
      expect(r.json.status).toBe('CANCELLED');
      expect(r.json.datesCancelled).toBe(1);
      expect(r.json.bookingsRequiringRefund).toEqual([`EVOPS-${suffix}`]);

      const event = await db!.event.findUniqueOrThrow({ where: { id: show.eventId } });
      expect(event.status).toBe('CANCELLED');
      const session = await db!.eventSession.findUniqueOrThrow({ where: { id: show.sessionId } });
      expect(session.status).toBe('CANCELLED');

      /*
        Opened at once by the cancellation itself, through the same call the ShowCancelled
        handler and the worker's sweep make (in-process delivery is off here, as on QA).
      */
      const refund = await db!.refund.findFirst({ where: { bookingId: booking.id } });
      expect(refund?.status).toBe('REQUESTED');
      expect(refund?.amountMinor).toBe(50_000);
      // The buyer is told it is a refund for a cancelled show, not warned about a request.
      const told = await db!.notification.findFirst({
        where: { bookingId: booking.id, type: 'REFUND_REQUESTED' },
      });
      expect((told?.payload as { showCancelled?: boolean } | null)?.showCancelled).toBe(true);

      // Sales have stopped: nothing more can be sold at the counter either.
      const after = await http('POST', `/organizations/${orgId}/counter-sales`, ownerToken, {
        eventSessionId: show.sessionId,
        items: [{ ticketTypeId: show.ticketTypeId, quantity: 1 }],
        buyerName: 'Too Late',
      });
      expect(after.status).toBe(409);

      // Pressing it again changes nothing and opens nothing twice.
      const again = await http('POST', `/events/${show.eventId}/cancel`, ownerToken, {
        reason: 'The band cannot travel.',
      });
      expect(again.status).toBe(201);
      expect(again.json.datesCancelled).toBe(0);
      await app!.get(CancellationRefundsService).sweep();
      expect(await db!.refund.count({ where: { bookingId: booking.id } })).toBe(1);
    },
  );

  maybe(
    'cancels an event with a counter cash sale: shown first, voided, listed, given back offline',
    async () => {
      const show = await gaEvent(orgId, 'CashCancel', 21_420);
      const sale = await http('POST', `/organizations/${orgId}/counter-sales`, ownerToken, {
        eventSessionId: show.sessionId,
        items: [{ ticketTypeId: show.ticketTypeId, quantity: 1 }],
        buyerName: 'Walk Counter Buyer',
      });
      expect(sale.status).toBe(201);
      const cashId = sale.json.bookingId as string;
      const cashTotal = sale.json.totalMinor as number;
      const sold = await db!.ticketInventory.findUniqueOrThrow({
        where: { ticketTypeId: show.ticketTypeId },
      });
      expect(sold.quantitySold).toBe(1);

      // Before confirming: the cash is named, with its total, apart from online refunds.
      const preview = await http('GET', `/events/${show.eventId}/cancel-preview`, ownerToken);
      expect(preview.status).toBe(200);
      expect(preview.json).toMatchObject({
        datesToCancel: 1,
        onlineRefunds: { count: 0, totals: [] },
        cash: { count: 1, totals: [{ currency: 'INR', amountMinor: cashTotal }] },
      });
      // The preview changed nothing.
      expect((await db!.booking.findUniqueOrThrow({ where: { id: cashId } })).status).toBe(
        'CONFIRMED',
      );
      expect(
        (await http('GET', `/events/${show.eventId}/cancel-preview`, managerToken)).status,
      ).toBe(403);

      const r = await http('POST', `/events/${show.eventId}/cancel`, ownerToken, {
        reason: 'The lawn is flooded.',
      });
      expect(r.status).toBe(201);
      expect(r.json.cashToReturn).toBe(1);
      expect(r.json.cashTotals).toEqual([{ currency: 'INR', amountMinor: cashTotal }]);
      expect(r.json.cashReturns).toEqual([
        expect.objectContaining({
          bookingId: cashId,
          buyerName: 'Walk Counter Buyer',
          amountMinor: cashTotal,
        }),
      ]);

      // Voided: booking cancelled, tickets dead, the stock no longer counted as sold.
      const after = await db!.booking.findUniqueOrThrow({
        where: { id: cashId },
        include: { tickets: true, refunds: true, payment: true },
      });
      expect(after.status).toBe('CANCELLED');
      expect(after.tickets.every((t: { status: string }) => t.status === 'CANCELLED')).toBe(true);
      // No money moved through anything: no refund row, no payment row.
      expect(after.refunds).toEqual([]);
      expect(after.payment).toBeNull();
      const inv = await db!.ticketInventory.findUniqueOrThrow({
        where: { ticketTypeId: show.ticketTypeId },
      });
      expect(inv.quantitySold).toBe(0);

      // The counter cannot print a ticket for it any more.
      const print = await http('GET', `/tickets/booking/${cashId}/print`, ownerToken);
      expect(print.status).toBe(200);
      expect(print.json).toEqual([]);

      // The list of cash to give back, and the offline record of handing it back.
      const owed = await http('GET', `/organizations/${orgId}/cash-returns`, ownerToken);
      expect(owed.status).toBe(200);
      expect(owed.json.map((x: { bookingId: string }) => x.bookingId)).toContain(cashId);
      expect(
        (
          await http(
            'POST',
            `/organizations/${orgId}/cash-returns/${cashId}/returned`,
            customerToken,
          )
        ).status,
      ).toBe(403);
      const back = await http(
        'POST',
        `/organizations/${orgId}/cash-returns/${cashId}/returned`,
        managerToken,
      );
      expect(back.status).toBe(201);
      expect(back.json.status).toBe('returned');
      const twice = await http(
        'POST',
        `/organizations/${orgId}/cash-returns/${cashId}/returned`,
        ownerToken,
      );
      expect(twice.json.status).toBe('already_returned');
      const row = await db!.booking.findUniqueOrThrow({ where: { id: cashId } });
      expect(row.cashReturnedAt).not.toBeNull();
      expect(await db!.refund.count({ where: { bookingId: cashId } })).toBe(0);
      const stillOwed = await http('GET', `/organizations/${orgId}/cash-returns`, ownerToken);
      expect(stillOwed.json.map((x: { bookingId: string }) => x.bookingId)).not.toContain(cashId);
      // The sweep finds nothing left to do on this show.
      await app!.get(CancellationRefundsService).sweep();
      expect(await db!.refund.count({ where: { bookingId: cashId } })).toBe(0);
    },
  );

  // ── 3. Seat classes, before the event exists ───────────────────────────────────────

  maybe(
    'names unmapped seat classes where a rule covers the place, and not where none does',
    async () => {
      const policy = await db!.cinemaPricingPolicy.create({
        data: {
          country,
          region: 'North',
          status: 'ACTIVE',
          maintenanceTreatment: 'NOT_APPLICABLE',
          onlineFeePolicy: 'ALLOWED',
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          regulatoryReference: `FIXTURE ${suffix}`,
        },
      });
      policyId = policy.id;

      const screenIn = async (region: string) => {
        const venue = await db!.venue.create({
          data: { organizationId: orgId, name: `Cinema ${region}`, city: 'Town', country, region },
        });
        const cinema = await db!.cinema.create({
          data: {
            organizationId: orgId,
            venueId: venue.id,
            name: `Cinema ${region} ${suffix}`,
            city: 'Town',
            country,
            region,
          },
        });
        const screen = await db!.screen.create({
          data: { venueId: venue.id, cinemaId: cinema.id, name: `Screen ${region}`, capacity: 10 },
        });
        await db!.seatMap.create({
          data: {
            screenId: screen.id,
            name: 'Main',
            status: 'PUBLISHED',
            categories: {
              create: [
                { name: 'Gold', basePriceMinor: 20_000 },
                { name: 'Silver', basePriceMinor: 10_000, regulatoryClass: 'REGULAR' },
              ],
            },
          },
        });
        return screen.id;
      };
      const north = await screenIn('North');
      const south = await screenIn('South');

      const r = await http('GET', `/events/seating-rooms?organizationId=${orgId}`, ownerToken);
      expect(r.status).toBe(200);
      const room = (id: string) =>
        (r.json as { id: string; seatClasses: any }[]).find((x) => x.id === id);
      expect(room(north)?.seatClasses).toMatchObject({ state: 'MAP_CLASSES', unmapped: ['Gold'] });
      expect(room(north)?.seatClasses.fixPath).toMatch(/\/readiness#seat-classes$/);
      // No rule covers South: mapping Gold would not open the sale, so it is not asked for.
      expect(room(south)?.seatClasses).toMatchObject({ state: 'NO_RULES', unmapped: [] });
    },
  );
});
