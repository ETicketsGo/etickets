import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppException } from '../common/errors';
import { RolesGuard } from '../auth/roles.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGroupingService } from './admin-grouping.service';
import { AdminRefundsController } from '../refunds/refunds.controller';
import { RefundsService } from '../refunds/refunds.service';
import { SettlementController } from '../payments/settlement/settlement.controller';
import { SettlementService } from '../payments/settlement/settlement.service';
import { AdminSupportController } from '../support/support.controller';
import { SupportService } from '../support/support.service';
import { AdminReportsController } from '../reports/reports.controller';
import { AuditQueryService } from '../audit/audit-query.service';
import { dayRangeWhere } from './list-filters';

/**
 * The finance and operations queues' filters: market, organizer, event, status and a UTC day
 * window, on payments, refunds, settlements, support and the audit log.
 *
 * ── WHAT THESE LOCK SHUT ───────────────────────────────────────────────────────────
 *  - Every filter is validated by the REAL schema on the REAL route, read off the controller's
 *    own decorator metadata. A copy of the schema in this file would pass while the route drifted.
 *  - A bad value is a 400, never an empty list: an empty list is a real answer on these screens.
 *  - Every filter reaches the database query, inside `AND`, so none can erase another.
 *  - The grouped summary above each money list filters on the same columns, or it would not add
 *    up to the list under it.
 *  - Each list stays admin-only: a customer or an organizer gets 403.
 */

type Ctor = { prototype: object; name: string };

/** The ZodValidationPipe a route applies to its query, taken from Nest's own route metadata. */
function queryPipe(controller: Ctor, method: string): ZodValidationPipe<unknown> {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) as Record<
    string,
    { pipes?: unknown[] }
  >;
  for (const arg of Object.values(args ?? {})) {
    const pipe = arg.pipes?.find((p) => p instanceof ZodValidationPipe);
    if (pipe) return pipe as ZodValidationPipe<unknown>;
  }
  throw new Error(`${controller.name}.${method} has no ZodValidationPipe`);
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppException ? e.getStatus() : -1;
  }
  return undefined;
}

/** Every list and summary this change filters, and a valid status for each. */
const ROUTES: { name: string; controller: Ctor; method: string; base: Record<string, string> }[] = [
  { name: 'bookings', controller: AdminController, method: 'bookings', base: {} },
  {
    name: 'bookings summary',
    controller: AdminController,
    method: 'groupedBookings',
    base: { groupBy: 'country' },
  },
  {
    name: 'payments',
    controller: AdminController,
    method: 'payments',
    base: { status: 'SUCCEEDED' },
  },
  {
    name: 'payments summary',
    controller: AdminController,
    method: 'groupedPayments',
    base: { groupBy: 'currency' },
  },
  { name: 'refunds', controller: AdminRefundsController, method: 'list', base: {} },
  {
    name: 'refunds summary',
    controller: AdminController,
    method: 'groupedRefunds',
    base: { groupBy: 'currency' },
  },
  { name: 'settlements', controller: SettlementController, method: 'list', base: {} },
  {
    name: 'settlements summary',
    controller: AdminController,
    method: 'groupedSettlements',
    base: { groupBy: 'currency' },
  },
  { name: 'support', controller: AdminSupportController, method: 'list', base: {} },
  { name: 'audit', controller: AdminReportsController, method: 'audit', base: {} },
  {
    name: 'audit summary',
    controller: AdminReportsController,
    method: 'auditSummary',
    base: {},
  },
];

const ORG = 'clorg0000000000000000000a';
const EVENT = 'clevt0000000000000000000a';

describe.each(ROUTES)(
  '$name: the query is validated on the route',
  ({ controller, method, base }) => {
    const pipe = queryPipe(controller, method);
    const parse = (extra: Record<string, unknown>) =>
      pipe.transform({ ...base, ...extra }, { type: 'query' }) as Record<string, unknown>;

    it('accepts the full set of filters', () => {
      const parsed = parse({ country: 'in', eventId: EVENT, from: '2026-10-01', to: '2026-10-09' });
      expect(parsed).toMatchObject({
        country: 'IN',
        eventId: EVENT,
        from: '2026-10-01',
        to: '2026-10-09',
      });
    });

    it('accepts a one-day window (from equals to)', () => {
      expect(statusOf(() => parse({ from: '2026-10-09', to: '2026-10-09' }))).toBeUndefined();
    });

    it.each([
      ['a country that is not a code', { country: 'India' }],
      ['a date in another shape', { from: '09/10/2026' }],
      ['a day that does not exist', { to: '2026-02-30' }],
      ['a month that does not exist', { from: '2026-13-01' }],
      ['a window that ends before it starts', { from: '2026-10-09', to: '2026-10-01' }],
      ['an event id that cannot be an id', { eventId: 'x; drop table' }],
    ])('refuses %s with a 400', (_label, extra) => {
      expect(statusOf(() => parse(extra))).toBe(400);
    });
  },
);

describe('status is the entity’s real lifecycle', () => {
  it.each([
    [AdminController, 'payments', 'SUCCEEDED', 'PAID'],
    [AdminRefundsController, 'list', 'REQUESTED', 'PENDING'],
    [SettlementController, 'list', 'TRANSFERRED', 'PAID'],
    [AdminSupportController, 'list', 'OPEN', 'RESOLVED'],
  ] as [Ctor, string, string, string][])(
    '%p.%s accepts %s and refuses %s',
    (controller, method, good, bad) => {
      const pipe = queryPipe(controller, method);
      expect(statusOf(() => pipe.transform({ status: good }, { type: 'query' }))).toBeUndefined();
      expect(statusOf(() => pipe.transform({ status: bad }, { type: 'query' }))).toBe(400);
    },
  );

  it('the organizer filter refuses a value that cannot be an id', () => {
    for (const [controller, method] of [
      [AdminController, 'payments'],
      [AdminRefundsController, 'list'],
      [AdminReportsController, 'audit'],
    ] as [Ctor, string][]) {
      const pipe = queryPipe(controller, method);
      expect(statusOf(() => pipe.transform({ organizationId: '../etc' }, { type: 'query' }))).toBe(
        400,
      );
    }
  });
});

describe('the day window is whole UTC days, both ends inclusive', () => {
  it('starts at midnight UTC on `from` and stops before midnight UTC after `to`', () => {
    expect(dayRangeWhere('2026-10-01', '2026-10-09')).toEqual({
      gte: new Date('2026-10-01T00:00:00.000Z'),
      lt: new Date('2026-10-10T00:00:00.000Z'),
    });
  });

  it('rolls over a month end', () => {
    expect(dayRangeWhere(undefined, '2026-10-31')).toEqual({
      lt: new Date('2026-11-01T00:00:00.000Z'),
    });
  });

  it('is nothing when no window was asked for', () => {
    expect(dayRangeWhere()).toBeNull();
  });
});

/* ── Each list applies every filter in the database ──────────────────────────────── */

const whereOf = (fn: jest.Mock) => fn.mock.calls[0][0].where;
const DAY = { gte: new Date('2026-10-01T00:00:00.000Z'), lt: new Date('2026-10-10T00:00:00.000Z') };
const FILTERS = {
  country: 'IN',
  organizationId: ORG,
  eventId: EVENT,
  from: '2026-10-01',
  to: '2026-10-09',
};
const INDIA = { in: expect.arrayContaining(['india', 'in']), mode: 'insensitive' };

describe('each list applies every filter, inside AND', () => {
  it('payments: venue country, the booking’s organizer and event, and when it was taken', async () => {
    const count = jest.fn();
    const prisma = {
      $transaction: jest.fn().mockResolvedValue([0, []]),
      payment: { count, findMany: jest.fn() },
    };
    await new AdminService(prisma as never, {} as never).payments({
      page: 1,
      pageSize: 15,
      status: 'SUCCEEDED',
      groupBy: 'country',
      groupKey: 'India',
      ...FILTERS,
    });
    const where = whereOf(count);
    expect(where.AND).toEqual([
      // The group scope survives beside the filters that also reach through `booking`.
      // A key that is a stored spelling is read as its market.
      { booking: { event: { venue: { country: INDIA } } } },
      { status: 'SUCCEEDED' },
      { booking: { event: { venue: { country: INDIA } } } },
      { booking: { organizationId: ORG } },
      { booking: { eventId: EVENT } },
      { createdAt: DAY },
    ]);
  });

  it('bookings: venue country, its organizer and event, and when it was made', async () => {
    const count = jest.fn();
    const prisma = {
      $transaction: jest.fn().mockResolvedValue([0, []]),
      booking: { count, findMany: jest.fn() },
    };
    await new AdminService(prisma as never, {} as never).bookings({
      page: 1,
      pageSize: 15,
      status: 'CONFIRMED',
      ...FILTERS,
    });
    const where = whereOf(count);
    expect(where.status).toBe('CONFIRMED');
    expect(where.AND).toEqual([
      { event: { venue: { country: INDIA } } },
      { organizationId: ORG },
      { eventId: EVENT },
      { createdAt: DAY },
    ]);
  });

  it('refunds: venue country, the refund’s own organizer, the booking’s event, when asked', async () => {
    const count = jest.fn();
    const prisma = {
      $transaction: jest.fn().mockResolvedValue([0, []]),
      refund: { count, findMany: jest.fn() },
    };
    const none = {} as never;
    const service = new RefundsService(prisma as never, none, none, none, none, none, none, none);
    await service.adminList('REQUESTED' as never, 1, 15, undefined, FILTERS);
    const where = whereOf(count);
    expect(where.AND).toEqual([
      { status: 'REQUESTED' },
      { booking: { event: { venue: { country: INDIA } } } },
      { organizationId: ORG },
      { booking: { eventId: EVENT } },
      { createdAt: DAY },
    ]);
  });

  it('settlements: venue country and created date, beside the organizer and event it had', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { settlement: { findMany, count: jest.fn().mockResolvedValue(31) } };
    const none = {} as never;
    const service = new SettlementService(prisma as never, none, none, none, none);
    const page = await service.list({ page: 1, pageSize: 15, ...FILTERS });
    const where = whereOf(findMany);
    expect(where).toMatchObject({ organizationId: ORG, eventId: EVENT });
    expect(where.AND).toEqual([{ event: { venue: { country: INDIA } } }, { createdAt: DAY }]);
    // The console pages with this; without it the pager had nothing to show.
    expect(page.meta.totalPages).toBe(3);
  });

  it('support: market resolved to the organizers registered there, event through the booking', async () => {
    const count = jest.fn();
    const organizationFindMany = jest.fn().mockResolvedValue([{ id: 'org-in-1' }]);
    const prisma = {
      $transaction: jest.fn().mockResolvedValue([0, []]),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'fb-1' }]),
      feedback: { count, findMany: jest.fn() },
      organization: { findMany: organizationFindMany },
      booking: { findMany: jest.fn().mockResolvedValue([]) },
    };
    await new SupportService(prisma as never).list({
      page: 1,
      pageSize: 15,
      status: 'OPEN',
      ...FILTERS,
    });
    expect(organizationFindMany.mock.calls[0][0].where).toEqual({ registeredCountry: INDIA });
    const where = whereOf(count);
    // The explicit organizer stays; the market narrows it rather than replacing it.
    expect(where).toMatchObject({ status: 'OPEN', organizationId: ORG });
    expect(where.AND).toEqual([
      { organizationId: { in: ['org-in-1'] } },
      { id: { in: ['fb-1'] } },
      { createdAt: DAY },
    ]);
  });

  it('audit: market by registered country, and an event by its own entries or ones naming it', async () => {
    const count = jest.fn();
    const prisma = {
      $transaction: jest.fn().mockResolvedValue([0, []]),
      auditLog: { count, findMany: jest.fn() },
      organization: { findMany: jest.fn().mockResolvedValue([{ id: 'org-in-1' }]) },
    };
    await new AuditQueryService(prisma as never).list(FILTERS, 1, 50);
    const where = whereOf(count);
    expect(where.organizationId).toBe(ORG);
    expect(where.AND).toEqual([
      { organizationId: { in: ['org-in-1'] } },
      {
        OR: [
          { entityType: 'Event', entityId: EVENT },
          { metadata: { path: ['eventId'], equals: EVENT } },
        ],
      },
    ]);
  });
});

describe('the grouped summary filters on the same columns as its list', () => {
  function grouping() {
    const $queryRawUnsafe = jest.fn().mockResolvedValue([]);
    return { service: new AdminGroupingService({ $queryRawUnsafe } as never), $queryRawUnsafe };
  }

  it.each([
    // Bookings take the same filters now (the bookings queue gained organizer, event and dates).
    ['bookings', 'b."organizationId"', 'b."eventId"', 'b."createdAt"'],
    ['payments', 'b."organizationId"', 'b."eventId"', 'p."createdAt"'],
    ['refunds', 'r."organizationId"', 'b."eventId"', 'r."createdAt"'],
    ['settlements', 's."organizationId"', 's."eventId"', 's."createdAt"'],
  ])('%s', async (resource, organizer, event, created) => {
    const { service, $queryRawUnsafe } = grouping();
    // Bookings have no currency grouping; the WHERE does not depend on the grouping.
    await service.grouped(resource, resource === 'bookings' ? 'organizer' : 'currency', FILTERS);

    // Both statements - the counts and the money - carry the same WHERE.
    expect($queryRawUnsafe).toHaveBeenCalledTimes(2);
    for (const [sql, ...params] of $queryRawUnsafe.mock.calls) {
      expect(sql).toContain('LOWER(v.country) = ANY($1::text[])');
      expect(sql).toContain(`${organizer} = $2`);
      expect(sql).toContain(`${event} = $3`);
      expect(sql).toContain(`${created} >= $4::timestamp`);
      expect(sql).toContain(`${created} < $5::timestamp`);
      expect(params).toEqual([
        expect.arrayContaining(['india']),
        ORG,
        EVENT,
        '2026-10-01 00:00:00',
        '2026-10-10 00:00:00',
      ]);
    }
  });

  it('a queue whose list has no such filter ignores it, as its list does', async () => {
    const { service, $queryRawUnsafe } = grouping();
    await service.grouped('events', 'organizer', { organizationId: ORG, from: '2026-10-01' });
    const [sql, ...params] = $queryRawUnsafe.mock.calls[0];
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([]);
  });
});

/* ── Authorization is unchanged: admin-only lists stay admin-only ─────────────────── */

function contextFor(controller: Ctor, method: string, roles: string[]): ExecutionContext {
  return {
    getHandler: () => (controller.prototype as Record<string, unknown>)[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', roles } }) }),
  } as unknown as ExecutionContext;
}

describe.each(ROUTES)('$name stays admin-only', ({ controller, method }) => {
  const guard = new RolesGuard(new Reflector());

  it.each([['CUSTOMER'], ['ORGANIZER_OWNER'], ['ORGANIZER_MANAGER']])(
    'refuses %s with a 403',
    (role) => {
      expect(statusOf(() => guard.canActivate(contextFor(controller, method, [role])))).toBe(403);
    },
  );

  it('lets an ADMIN through', () => {
    expect(guard.canActivate(contextFor(controller, method, ['ADMIN']))).toBe(true);
  });
});
