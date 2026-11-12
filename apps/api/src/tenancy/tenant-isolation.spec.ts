import 'reflect-metadata';
import { ErrorCodes } from '../common/errors';
import { MetricsService } from '../metrics/metrics.service';
import { EventsService } from '../events/events.service';
import { EventAttendeesService } from '../attendees/event-attendees.service';
import { EventAttendeesController } from '../attendees/event-attendees.controller';
import { CheckinsService } from '../checkins/checkins.service';
import { RefundsService } from '../refunds/refunds.service';
import { CashReturnsService } from '../refunds/cash-returns.service';
import { PaymentsController } from '../payments/payments.controller';
import { PayoutsService, payableBookingWhere } from '../payouts/payouts.service';
import { PayoutAccountsService } from '../payouts/payout-accounts.service';
import { UnifiedFinanceService } from '../finance/unified-finance.service';
import {
  ReceiptsController,
  OrganizationReceiptsController,
} from '../receipts/receipts.controller';
import { ReceiptsService } from '../receipts/receipts.service';
import { TicketsService } from '../tickets/tickets.service';
import { CouponsService } from '../coupons/coupons.service';
import { ReportsService } from '../reports/reports.service';
import { AnalyticsService } from '../analytics/analytics.service';
import {
  BUYER,
  DOOR_B,
  ORG_A,
  ORG_B,
  OWNER_A,
  OWNER_B,
  dataCalls,
  expectReachesData,
  expectRefused,
  tenantWorld,
  type TenantWorld,
} from './tenant-isolation.fixture';

/**
 * One organizer cannot read or change another organizer's data through the API.
 *
 * Every case is the same shape: organization A owns a resource; the owner of organization B (a
 * fully privileged organizer, just not A's) presents A's id. B must be refused - TENANT_FORBIDDEN
 * where the route takes A's id directly, NOT_FOUND where B names its OWN organization and a
 * resource that is not in it - and nothing protected may be read first. Then A makes the same
 * call and must get past the check, so the refusal is the tenant rule and not a broken double.
 *
 * List routes taking an organization id are also checked to put that id in the query itself.
 * See `tenant-isolation.fixture.ts` for the strict Prisma double this relies on.
 */

/** A lookup by id that answers only for the given rows. */
const byId =
  <T extends { id: string }>(...rows: T[]) =>
  async (args: { where: { id: string } }) =>
    rows.find((r) => r.id === args.where.id) ?? null;

const EVENT_A = {
  id: 'event-a',
  organizationId: ORG_A,
  slug: 'event-a',
  title: 'A',
  isFree: false,
  venue: { timezone: 'UTC', country: 'US' },
  sessions: [],
};

// ──────────────────────────── bookings (organizer lists) ────────────────────────────

describe('tenant isolation: organizer booking lists', () => {
  const events = (w: TenantWorld) =>
    new EventsService(
      w.prisma as never,
      w.access,
      w.audit as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
    );

  it("GET /events/:id/orders refuses B on A's event before reading any booking", async () => {
    const w = tenantWorld({ event: { findUnique: byId(EVENT_A) } });
    await expectRefused(events(w).orders(OWNER_B, EVENT_A.id, { page: 1, pageSize: 25 }));
    expect(dataCalls(w)).toEqual(['event.findUnique']);
  });

  it('GET /events/:id/orders lets A through to its bookings', async () => {
    const w = tenantWorld({ event: { findUnique: byId(EVENT_A) } });
    await expectReachesData(events(w).orders(OWNER_A, EVENT_A.id, { page: 1, pageSize: 25 }));
    expect(dataCalls(w)).toContain('$transaction');
  });

  const checkins = (w: TenantWorld, qr: object = {}) =>
    new CheckinsService(
      w.prisma as never,
      qr as never,
      w.access,
      w.audit as never,
      {} as never,
      new MetricsService(),
    );

  it("GET /checkins/bookings (search) refuses B naming A's organization", async () => {
    const w = tenantWorld();
    await expectRefused(checkins(w).findBookings(OWNER_B, ORG_A, 'smith'));
    expect(dataCalls(w)).toEqual([]);
  });

  it('GET /checkins/bookings (search) scopes the query to the named organization', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const w = tenantWorld({ booking: { findMany } });
    await checkins(w).findBookings(OWNER_B, ORG_B, 'smith');
    expect(findMany.mock.calls[0][0].where.organizationId).toBe(ORG_B);
  });

  it("GET /checkins/bookings/recent refuses B naming A's organization", async () => {
    const w = tenantWorld();
    await expectRefused(checkins(w).listRecentBookings(OWNER_B, ORG_A, {}));
    expect(dataCalls(w)).toEqual([]);
  });

  it("GET /checkins/bookings/recent with A's event id stays inside B's organization", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const w = tenantWorld({ booking: { findMany } });
    await checkins(w).listRecentBookings(OWNER_B, ORG_B, { eventId: EVENT_A.id });
    const where = findMany.mock.calls[0][0].where;
    // Both conditions, so another organization's event id selects nothing of theirs.
    expect(where.organizationId).toBe(ORG_B);
    expect(where.eventId).toBe(EVENT_A.id);
  });
});

// ──────────────────────────── attendees and export ────────────────────────────

describe('tenant isolation: attendee list and CSV export', () => {
  const service = (w: TenantWorld) =>
    new EventAttendeesService(w.prisma as never, w.access, w.audit as never);
  const world = () => tenantWorld({ event: { findUnique: byId(EVENT_A) } });

  it("GET /events/:id/attendees refuses B on A's event before any attendee row is read", async () => {
    const w = world();
    await expectRefused(service(w).list(OWNER_B, EVENT_A.id, {}, 1, 25));
    expect(dataCalls(w)).toEqual(['event.findUnique']);
  });

  it("refuses B's check-in staff too", async () => {
    const w = world();
    await expectRefused(service(w).list(DOOR_B, EVENT_A.id, {}, 1, 25));
    expect(dataCalls(w)).toEqual(['event.findUnique']);
  });

  it('lets A read its own attendees', async () => {
    const w = world();
    await expectReachesData(service(w).list(OWNER_A, EVENT_A.id, {}, 1, 25));
    expect(dataCalls(w)).toContain('$queryRaw');
  });

  it("export authorization refuses B on A's event", async () => {
    const w = world();
    await expectRefused(service(w).authorizeExport(OWNER_B, EVENT_A.id));
    expect(dataCalls(w)).toEqual(['event.findUnique']);
  });

  it("export authorization for A carries A's organization (the export writes only that event)", async () => {
    const w = world();
    const ctx = await service(w).authorizeExport(OWNER_A, EVENT_A.id);
    expect(ctx).toMatchObject({ eventId: EVENT_A.id, organizationId: ORG_A });
  });

  it('GET /events/:id/attendees/export refuses before a header or a byte is written', async () => {
    const w = world();
    const svc = service(w);
    const writeExport = jest.spyOn(svc, 'writeExport');
    const controller = new EventAttendeesController(svc);
    const res = {
      status: jest.fn(),
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
    };
    await expectRefused(controller.export(OWNER_B, EVENT_A.id, {}, res as never));
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
    expect(writeExport).not.toHaveBeenCalled();
  });
});

// ──────────────────────────── payments and refunds ────────────────────────────

describe('tenant isolation: payments and refunds', () => {
  const BOOKING_A = {
    id: 'booking-a',
    organizationId: ORG_A,
    userId: BUYER.id,
    tickets: [],
  };
  const REFUND_A = { id: 'refund-a', organizationId: ORG_A, status: 'REQUESTED' };

  const refunds = (w: TenantWorld) =>
    new RefundsService(
      w.prisma as never,
      {} as never,
      {} as never,
      w.access,
      w.audit as never,
      { send: jest.fn() } as never,
      new MetricsService(),
      { issueCreditNote: jest.fn() } as never,
    );

  it("POST /refunds/:id/process refuses B deciding A's refund, and changes nothing", async () => {
    const w = tenantWorld({ refund: { findUnique: byId(REFUND_A) } });
    await expectRefused(refunds(w).process(OWNER_B, REFUND_A.id, 'APPROVE'));
    await expectRefused(refunds(w).process(OWNER_B, REFUND_A.id, 'REJECT'));
    expect(dataCalls(w)).toEqual(['refund.findUnique', 'refund.findUnique']);
  });

  it("POST /refunds/:id/process lets A's owner decide A's refund", async () => {
    const w = tenantWorld({ refund: { findUnique: byId(REFUND_A) } });
    await expectReachesData(refunds(w).process(OWNER_A, REFUND_A.id, 'REJECT'));
    expect(dataCalls(w)).toContain('refund.updateMany');
  });

  it("GET /organizations/:organizationId/refunds refuses B naming A's organization", async () => {
    const w = tenantWorld();
    await expectRefused(refunds(w).listForOrganization(OWNER_B, ORG_A, {}));
    expect(dataCalls(w)).toEqual([]);
  });

  it("GET /refunds/booking/:bookingId refuses an organizer for A's customer's booking", async () => {
    const w = tenantWorld({ booking: { findUnique: byId(BOOKING_A) } });
    await expectRefused(
      refunds(w).listForBookingOwner(OWNER_B, BOOKING_A.id),
      ErrorCodes.FORBIDDEN,
    );
    expect(dataCalls(w)).toEqual(['booking.findUnique']);
  });

  it('GET /refunds/booking/:bookingId still answers the buyer', async () => {
    const w = tenantWorld({ booking: { findUnique: byId(BOOKING_A) } });
    await expectReachesData(refunds(w).listForBookingOwner(BUYER, BOOKING_A.id));
    expect(dataCalls(w)).toContain('refund.findMany');
  });

  it("POST /refunds refuses an organizer requesting a refund on A's customer's booking", async () => {
    const w = tenantWorld({ booking: { findUnique: byId(BOOKING_A) } });
    await expect(
      refunds(w).request(OWNER_B, { bookingId: BOOKING_A.id } as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(dataCalls(w)).toEqual(['booking.findUnique']);
  });

  const paymentsController = (w: TenantWorld, collectCash: jest.Mock) =>
    new PaymentsController(
      { collectCash } as never,
      {} as never,
      {} as never,
      w.access,
      w.prisma as never,
    );

  it.each([
    ['owner', OWNER_B],
    ['check-in staff', DOOR_B],
  ])("POST /payments/:bookingId/collect-cash refuses B's %s on A's booking", async (_l, user) => {
    const collectCash = jest.fn();
    const w = tenantWorld({ booking: { findUnique: byId(BOOKING_A) } });
    await expectRefused(paymentsController(w, collectCash).collectCash(user, BOOKING_A.id));
    expect(collectCash).not.toHaveBeenCalled();
  });

  it("POST /payments/:bookingId/collect-cash lets A collect on A's booking", async () => {
    const collectCash = jest.fn().mockResolvedValue({ status: 'confirmed' });
    const w = tenantWorld({ booking: { findUnique: byId(BOOKING_A) } });
    await paymentsController(w, collectCash).collectCash(OWNER_A, BOOKING_A.id);
    expect(collectCash).toHaveBeenCalledWith(BOOKING_A.id, OWNER_A.id);
  });
});

// ──────────────────────────── payouts and settlements ────────────────────────────

describe('tenant isolation: payouts, finance and cash settlement', () => {
  const payouts = (w: TenantWorld) =>
    new PayoutsService(w.prisma as never, w.access, w.audit as never, {} as never);
  const accounts = (w: TenantWorld) =>
    new PayoutAccountsService(
      w.prisma as never,
      w.access,
      w.audit as never,
      { get: () => undefined } as never,
      {} as never,
    );
  const ACCOUNT_A = { id: 'acct-a', organizationId: ORG_A, version: 1, disputedAt: null };

  it.each([
    ['GET /payouts', (s: PayoutsService) => s.listForOrg(OWNER_B, ORG_A)],
    ['GET /payouts/summary', (s: PayoutsService) => s.summary(OWNER_B, ORG_A, EVENT_A.id)],
    ['GET /payouts/account-state', (s: PayoutsService) => s.accountState(OWNER_B, ORG_A)],
    ['POST /payouts/generate', (s: PayoutsService) => s.generate(OWNER_B, ORG_A, EVENT_A.id)],
  ])("%s refuses B naming A's organization before reading money", async (_route, call) => {
    const w = tenantWorld();
    await expectRefused(call(payouts(w)));
    expect(dataCalls(w)).toEqual([]);
  });

  it('GET /payouts scopes the list to the named organization', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const w = tenantWorld({ payout: { findMany } });
    await payouts(w).listForOrg(OWNER_B, ORG_B);
    expect(findMany.mock.calls[0][0].where).toEqual({ organizationId: ORG_B });
  });

  it("an event filter never widens settlement past the organization (B's org + A's event = B's rows)", () => {
    const where = payableBookingWhere({
      organizationId: ORG_B,
      eventId: EVENT_A.id,
      eventFilter: {},
      transferredEventIds: [],
      bookingWindows: [],
      eventSettled: [],
    });
    expect(where.organizationId).toBe(ORG_B);
    expect(where.eventId).toBe(EVENT_A.id);
  });

  it("GET /payouts/finance refuses B naming A's organization", async () => {
    const w = tenantWorld();
    await expectRefused(
      new UnifiedFinanceService(w.prisma as never, w.access).forOrganization(OWNER_B, ORG_A),
    );
    expect(dataCalls(w)).toEqual([]);
  });

  it.each([
    ['GET /payouts/accounts', (s: PayoutAccountsService) => s.listForOrg(OWNER_B, ORG_A)],
    [
      'GET /payouts/accounts/history',
      (s: PayoutAccountsService) => s.historyForOrg(OWNER_B, ORG_A),
    ],
  ])("%s refuses B naming A's organization", async (_route, call) => {
    const w = tenantWorld();
    await expectRefused(call(accounts(w)));
    expect(dataCalls(w)).toEqual([]);
  });

  it("POST /payouts/accounts/:id/confirm and /dispute refuse B on A's bank account", async () => {
    const w = tenantWorld({ organizerPayoutAccount: { findUnique: byId(ACCOUNT_A) } });
    await expectRefused(
      accounts(w).confirm(OWNER_B, ACCOUNT_A.id, {
        version: 1,
        accountNumber: '000123456789',
        bankCode: 'HDFC0000001',
      }),
    );
    await expectRefused(
      accounts(w).dispute(OWNER_B, ACCOUNT_A.id, { version: 1, reason: 'Wrong holder name' }),
    );
    // Read to find the owner, and nothing written.
    expect(dataCalls(w)).toEqual([
      'organizerPayoutAccount.findUnique',
      'organizerPayoutAccount.findUnique',
    ]);
  });

  it("POST /payouts/accounts/:id/dispute lets A's owner through", async () => {
    const w = tenantWorld({ organizerPayoutAccount: { findUnique: byId(ACCOUNT_A) } });
    await expectReachesData(
      accounts(w).dispute(OWNER_A, ACCOUNT_A.id, { version: 1, reason: 'Wrong holder name' }),
    );
    expect(dataCalls(w)).toContain('organizerPayoutAccount.updateMany');
  });

  const cash = (w: TenantWorld) =>
    new CashReturnsService(w.prisma as never, {} as never, w.access, w.audit as never, {} as never);
  const CASH_BOOKING_A = {
    id: 'booking-a',
    organizationId: ORG_A,
    paymentMethod: 'CASH',
    status: 'CANCELLED',
    cashCollectedAt: new Date(),
    cashReturnedAt: null,
    Receipt: [],
  };

  it("cash returns: B's own organization plus A's booking reads as not found", async () => {
    const w = tenantWorld({ booking: { findUnique: byId(CASH_BOOKING_A) } });
    await expectRefused(
      cash(w).markReturned(OWNER_B, ORG_B, CASH_BOOKING_A.id),
      ErrorCodes.NOT_FOUND,
    );
    expect(dataCalls(w)).toEqual(['booking.findUnique']);
  });

  it("cash returns: B naming A's organization is refused before any booking is read", async () => {
    const w = tenantWorld({ booking: { findUnique: byId(CASH_BOOKING_A) } });
    await expectRefused(cash(w).markReturned(OWNER_B, ORG_A, CASH_BOOKING_A.id));
    await expectRefused(cash(w).list(OWNER_B, ORG_A));
    expect(dataCalls(w)).toEqual([]);
  });
});

// ──────────────────────────── receipts ────────────────────────────

describe('tenant isolation: receipts', () => {
  const BOOKING_A = { id: 'booking-a', organizationId: ORG_A, userId: BUYER.id };
  const DOC = { number: 'A-2026-0001' };

  function setup() {
    const w = tenantWorld({
      booking: { findUnique: byId(BOOKING_A) },
      user: { findUnique: async () => ({ locale: 'en' }) },
    });
    const receipts = {
      document: jest.fn(async (id: string) => {
        if (id !== 'rcpt-a') throw new Error('unexpected receipt');
        return {
          receipt: { organizationId: ORG_A, bookingId: BOOKING_A.id, number: DOC.number },
          document: DOC,
        };
      }),
      listForBooking: jest.fn().mockResolvedValue([]),
      listForOrganization: jest.fn().mockResolvedValue({ items: [] }),
    };
    return {
      w,
      receipts,
      controller: new ReceiptsController(receipts as never, w.prisma as never, w.access),
      orgController: new OrganizationReceiptsController(receipts as never, w.access),
    };
  }

  it("GET /receipts/:id and /receipts/:id/html refuse B on A's receipt", async () => {
    const { controller } = setup();
    await expectRefused(controller.get(OWNER_B, 'rcpt-a'));
    await expectRefused(controller.html(OWNER_B, 'rcpt-a'));
  });

  it("GET /receipts/:id answers A's owner and the buyer", async () => {
    const { controller } = setup();
    await expect(controller.get(OWNER_A, 'rcpt-a')).resolves.toBe(DOC);
    await expect(controller.get(BUYER, 'rcpt-a')).resolves.toBe(DOC);
  });

  it("GET /receipts/booking/:bookingId refuses B on A's booking without listing", async () => {
    const { controller, receipts } = setup();
    await expectRefused(controller.listForBooking(OWNER_B, BOOKING_A.id));
    expect(receipts.listForBooking).not.toHaveBeenCalled();
  });

  it("GET /organizations/:organizationId/receipts refuses B naming A's organization", async () => {
    const { orgController, receipts } = setup();
    await expectRefused(orgController.list(OWNER_B, ORG_A, { page: 1, pageSize: 25 } as never));
    expect(receipts.listForOrganization).not.toHaveBeenCalled();
  });

  it('the organization receipt list query is scoped by organization', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const w = tenantWorld({ receipt: { findMany, count } });
    await new ReceiptsService(w.prisma as never).listForOrganization(ORG_B, {});
    expect(findMany.mock.calls[0][0].where.organizationId).toBe(ORG_B);
    expect(count.mock.calls[0][0].where.organizationId).toBe(ORG_B);
  });
});

// ──────────────────────────── check-in and printed tickets ────────────────────────────

describe('tenant isolation: check-in lookups and actions', () => {
  const TICKET_A = {
    id: 'ticket-a',
    organizationId: ORG_A,
    nonce: 'n-1',
    ticketType: { name: 'GA' },
    booking: { reference: 'ETG-A-1', status: 'CONFIRMED' },
  };
  const SESSION_A = { id: 'session-a', event: { organizationId: ORG_A } };
  const checkins = (w: TenantWorld) =>
    new CheckinsService(
      w.prisma as never,
      { verify: () => ({ ticketId: TICKET_A.id, nonce: TICKET_A.nonce }) } as never,
      w.access,
      w.audit as never,
      {} as never,
      new MetricsService(),
    );
  const world = () =>
    tenantWorld({
      ticket: { findUnique: byId(TICKET_A) },
      eventSession: { findUnique: byId(SESSION_A) },
    });

  it.each([
    ['owner', OWNER_B],
    ['check-in staff', DOOR_B],
  ])(
    "POST /checkins (scan) refuses B's %s with A's ticket, and admits nobody",
    async (_l, user) => {
      const w = world();
      await expectRefused(checkins(w).scan(user, 'signed-token', {}));
      expect(dataCalls(w)).toEqual(['ticket.findUnique']);
    },
  );

  it("POST /checkins (scan) lets A's staff go on to admit A's ticket", async () => {
    const w = world();
    await expectReachesData(checkins(w).scan(OWNER_A, 'signed-token', {}));
  });

  it("POST /checkins/visual refuses B with A's ticket id", async () => {
    const w = world();
    await expectRefused(checkins(w).admitVisually(DOOR_B, TICKET_A.id));
    expect(dataCalls(w)).toEqual(['ticket.findUnique']);
  });

  it("POST /checkins/reverse refuses B on A's ticket and writes nothing", async () => {
    const w = world();
    await expectRefused(checkins(w).reverse(OWNER_B, TICKET_A.id));
    expect(dataCalls(w)).toEqual(['ticket.findUnique']);
  });

  it("GET /checkins/roster refuses B for A's session", async () => {
    const w = world();
    await expectRefused(checkins(w).roster(DOOR_B, SESSION_A.id));
    expect(dataCalls(w)).toEqual(['eventSession.findUnique']);
  });

  it("GET /checkins/roster lets A's staff read A's session", async () => {
    const w = world();
    await expectReachesData(checkins(w).roster(OWNER_A, SESSION_A.id));
  });

  it("GET /checkins/sessions refuses B naming A's organization", async () => {
    const w = world();
    await expectRefused(checkins(w).gateSessions(DOOR_B, ORG_A));
    expect(dataCalls(w)).toEqual([]);
  });

  it("GET /tickets/booking/:bookingId/print refuses B on A's booking before any ticket is signed", async () => {
    const w = tenantWorld({
      booking: {
        findUnique: byId({ id: 'booking-a', organizationId: ORG_A, status: 'CONFIRMED' }),
      },
    });
    const qr = { sign: jest.fn() };
    const tickets = new TicketsService(w.prisma as never, qr as never, w.access, w.audit as never);
    await expectRefused(tickets.ticketsForBookingAsStaff(DOOR_B, 'booking-a'));
    expect(dataCalls(w)).toEqual(['booking.findUnique']);
    await expectReachesData(tickets.ticketsForBookingAsStaff(OWNER_A, 'booking-a'));
    expect(dataCalls(w)).toContain('ticket.findMany');
  });
});

// ──────────────────────────── coupons ────────────────────────────

describe('tenant isolation: coupons', () => {
  const COUPON_A = { id: 'coupon-a', organizationId: ORG_A, redemptions: 0, code: 'A10' };
  const coupons = (w: TenantWorld) =>
    new CouponsService(w.prisma as never, w.access, w.audit as never);

  it("PATCH and DELETE /coupons/:id refuse B on A's coupon and change nothing", async () => {
    const w = tenantWorld({ coupon: { findUnique: byId(COUPON_A) } });
    await expectRefused(coupons(w).update(OWNER_B, COUPON_A.id, { status: 'INACTIVE' } as never));
    await expectRefused(coupons(w).remove(OWNER_B, COUPON_A.id));
    expect(dataCalls(w)).toEqual(['coupon.findUnique', 'coupon.findUnique']);
  });

  it("DELETE /coupons/:id lets A delete A's unused coupon", async () => {
    const w = tenantWorld({ coupon: { findUnique: byId(COUPON_A) } });
    await expectReachesData(coupons(w).remove(OWNER_A, COUPON_A.id));
    expect(dataCalls(w)).toContain('coupon.delete');
  });

  it("GET and POST /coupons refuse B naming A's organization", async () => {
    const w = tenantWorld();
    await expectRefused(coupons(w).list(OWNER_B, ORG_A));
    await expectRefused(
      coupons(w).create(OWNER_B, {
        organizationId: ORG_A,
        code: 'X',
        type: 'PERCENT',
        value: 10,
      } as never),
    );
    expect(dataCalls(w)).toEqual([]);
  });

  it('GET /coupons scopes rows and count to the named organization', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const w = tenantWorld({ coupon: { findMany, count } });
    await coupons(w).list(OWNER_B, ORG_B);
    expect(findMany.mock.calls[0][0].where).toEqual({ organizationId: ORG_B });
    expect(count.mock.calls[0][0].where).toEqual({ organizationId: ORG_B });
  });
});

// ──────────────────────────── event analytics and reports ────────────────────────────

describe('tenant isolation: event analytics and reports', () => {
  const VENUE_A = { id: 'venue-a', organizationId: ORG_A, name: 'A Hall', city: 'X' };
  const world = () =>
    tenantWorld({ event: { findUnique: byId(EVENT_A) }, venue: { findUnique: byId(VENUE_A) } });
  const reports = (w: TenantWorld) => new ReportsService(w.prisma as never, w.access);
  const analytics = (w: TenantWorld) =>
    new AnalyticsService(w.prisma as never, w.access, reports(w));

  it("GET /reports/events/:eventId (JSON and CSV) refuses B on A's event", async () => {
    const w = world();
    await expectRefused(reports(w).organizerEventReport(OWNER_B, EVENT_A.id));
    await expectRefused(reports(w).organizerEventReportCsv(OWNER_B, EVENT_A.id));
    expect(dataCalls(w)).toEqual(['event.findUnique', 'event.findUnique']);
  });

  it("GET /reports/events/:eventId/commerce (JSON and CSV) refuses B on A's event", async () => {
    const w = world();
    await expectRefused(reports(w).organizerCommerceReport(OWNER_B, EVENT_A.id));
    await expectRefused(reports(w).organizerCommerceReportCsv(OWNER_B, EVENT_A.id));
    expect(dataCalls(w)).toEqual(['event.findUnique', 'event.findUnique']);
  });

  it("GET /reports/events/:eventId lets A read A's event", async () => {
    const w = world();
    await expectReachesData(reports(w).organizerEventReport(OWNER_A, EVENT_A.id));
    expect(dataCalls(w).length).toBeGreaterThan(1);
  });

  it("GET /analytics/organizer refuses B naming A's organization", async () => {
    const w = world();
    await expectRefused(analytics(w).organizer(OWNER_B, ORG_A));
    expect(dataCalls(w)).toEqual([]);
  });

  it("GET /analytics/venue/:venueId refuses B on A's venue", async () => {
    const w = world();
    await expectRefused(analytics(w).venue(OWNER_B, VENUE_A.id));
    expect(dataCalls(w)).toEqual(['venue.findUnique']);
    await expectReachesData(analytics(w).venue(OWNER_A, VENUE_A.id));
  });
});
