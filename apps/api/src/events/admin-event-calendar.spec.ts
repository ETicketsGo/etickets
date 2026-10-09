import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { AdminPermission } from '@eticketsgo/shared-types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppException } from '../common/errors';
import { RolesGuard } from '../auth/roles.guard';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { AdminEventsController } from './events.controller';
import { EventsService } from './events.service';
import {
  CALENDAR_LIMIT,
  adminCalendarRow,
  adminCalendarWhere,
  type AdminCalendarDbRow,
} from './admin-event-calendar';

/**
 * The admin calendar: sessions across organizers, in a window, placed in the venue's zone.
 *
 * ── WHAT THESE LOCK SHUT ───────────────────────────────────────────────────────────
 *  - The window is validated by the REAL schema on the REAL route: both ends required, the end
 *    not before the start, and the span capped - an unbounded calendar is a full-table read.
 *  - Every filter reaches the query inside `AND`, so country and status (both through `event`)
 *    cannot overwrite each other.
 *  - The zone is the venue's, then the room's, and NEVER a guessed launch-market zone.
 *  - The row carries nothing the event list does not already show an admin.
 *  - The route stays admin-only and needs EVENT_REVIEW, the same duty as the moderation queue.
 */

function queryPipe(): ZodValidationPipe<unknown> {
  const args = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    AdminEventsController,
    'calendar',
  ) as Record<string, { pipes?: unknown[] }>;
  for (const arg of Object.values(args ?? {})) {
    const pipe = arg.pipes?.find((p) => p instanceof ZodValidationPipe);
    if (pipe) return pipe as ZodValidationPipe<unknown>;
  }
  throw new Error('AdminEventsController.calendar has no ZodValidationPipe');
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppException ? e.getStatus() : -1;
  }
  return undefined;
}

const parse = (q: Record<string, unknown>) =>
  queryPipe().transform(q, { type: 'query' }) as Record<string, unknown>;

describe('admin calendar: the window is validated on the route', () => {
  it('accepts a padded month with every filter', () => {
    expect(
      parse({
        from: '2026-09-30',
        to: '2026-11-01',
        country: 'in',
        organizationId: 'clorg0000000000000000000a',
        status: 'PUBLISHED',
      }),
    ).toMatchObject({ from: '2026-09-30', to: '2026-11-01', country: 'IN', status: 'PUBLISHED' });
  });

  it('accepts exactly the longest window, and a one-day one', () => {
    // 2026-10-01 .. 2026-12-01 inclusive is 62 days.
    expect(statusOf(() => parse({ from: '2026-10-01', to: '2026-12-01' }))).toBeUndefined();
    expect(statusOf(() => parse({ from: '2026-10-09', to: '2026-10-09' }))).toBeUndefined();
  });

  it.each([
    ['no window at all', {}],
    ['a start with no end', { from: '2026-10-01' }],
    ['an end with no start', { to: '2026-10-31' }],
    ['a window that ends before it starts', { from: '2026-10-09', to: '2026-10-01' }],
    ['a window one day too long', { from: '2026-10-01', to: '2026-12-02' }],
    ['a day that does not exist', { from: '2026-02-30', to: '2026-03-02' }],
    ['a country that is not a code', { from: '2026-10-01', to: '2026-10-02', country: 'India' }],
    [
      'a status that is not an event status',
      { from: '2026-10-01', to: '2026-10-02', status: 'LIVE' },
    ],
    [
      'an organizer id that cannot be an id',
      { from: '2026-10-01', to: '2026-10-02', organizationId: 'x; drop' },
    ],
  ])('refuses %s with a 400', (_label, q) => {
    expect(statusOf(() => parse(q))).toBe(400);
  });
});

describe('admin calendar: the query', () => {
  it('is whole UTC days, inclusive at both ends', () => {
    const where = adminCalendarWhere({ from: '2026-10-01', to: '2026-10-31' }) as {
      AND: Record<string, unknown>[];
    };
    expect(where.AND).toEqual([
      {
        startsAt: {
          gte: new Date('2026-10-01T00:00:00.000Z'),
          lt: new Date('2026-11-01T00:00:00.000Z'),
        },
      },
    ]);
  });

  it('puts every filter in AND, so none overwrites another', () => {
    const where = adminCalendarWhere({
      from: '2026-10-01',
      to: '2026-10-31',
      country: 'IN',
      organizationId: 'org1',
      status: 'PUBLISHED' as never,
    }) as { AND: Record<string, unknown>[] };
    expect(where.AND).toHaveLength(4);
    expect(where.AND[1]).toEqual({
      event: { venue: { country: expect.objectContaining({ mode: 'insensitive' }) } },
    });
    expect(where.AND[2]).toEqual({ event: { organizationId: 'org1' } });
    expect(where.AND[3]).toEqual({ event: { status: 'PUBLISHED' } });
  });

  it('asks for one more than the cap and says when the window was truncated', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue(
        Array.from({ length: CALENDAR_LIMIT + 1 }, (_, i) => row({ id: `s${i}` })),
      );
    const service = Object.create(EventsService.prototype) as EventsService;
    (service as unknown as { prisma: unknown }).prisma = { eventSession: { findMany } };

    const out = await service.adminCalendar({ from: '2026-10-01', to: '2026-10-31' });

    expect(findMany.mock.calls[0][0]).toMatchObject({
      take: CALENDAR_LIMIT + 1,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    expect(out.data).toHaveLength(CALENDAR_LIMIT);
    expect(out.meta).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      limit: CALENDAR_LIMIT,
      truncated: true,
    });
  });

  it('is not truncated when it fits', async () => {
    const findMany = jest.fn().mockResolvedValue([row()]);
    const service = Object.create(EventsService.prototype) as EventsService;
    (service as unknown as { prisma: unknown }).prisma = { eventSession: { findMany } };
    const out = await service.adminCalendar({ from: '2026-10-01', to: '2026-10-31' });
    expect(out.meta.truncated).toBe(false);
    expect(out.data).toHaveLength(1);
  });
});

function row(patch: Partial<AdminCalendarDbRow> = {}): AdminCalendarDbRow {
  return {
    id: 's1',
    startsAt: new Date('2026-10-09T19:00:00.000Z'),
    endsAt: new Date('2026-10-09T21:00:00.000Z'),
    status: 'SCHEDULED',
    screen: null,
    event: {
      id: 'e1',
      title: 'Jazz night',
      status: 'PUBLISHED',
      category: 'MUSIC',
      organization: { id: 'o1', name: 'Bengaluru Live' },
      venue: { name: 'Hall', city: 'Sydney', country: 'AU', timezone: 'Australia/Sydney' },
    },
    ...patch,
  };
}

describe('admin calendar: which zone a session is read in', () => {
  it("uses the venue's own zone first", () => {
    expect(adminCalendarRow(row()).timezone).toBe('Australia/Sydney');
  });

  it("falls back to the room's place when the venue was never given a zone", () => {
    const r = row({
      screen: { name: 'Screen 2', venue: null, cinema: { timezone: 'America/Toronto' } },
    });
    // Canada spans six zones, so the country cannot answer and the room's cinema does.
    r.event.venue = { name: 'Hall', city: 'Toronto', country: 'CA', timezone: null };
    const out = adminCalendarRow(r);
    expect(out.timezone).toBe('America/Toronto');
    expect(out.room).toBe('Screen 2');
  });

  it('answers null rather than guess the launch market', () => {
    const r = row();
    r.event.venue = { name: 'Hall', city: 'Toronto', country: 'CA', timezone: null };
    expect(adminCalendarRow(r).timezone).toBeNull();
  });

  it('carries the event, organizer and place, and nothing else', () => {
    const out = adminCalendarRow(row());
    expect(Object.keys(out).sort()).toEqual(
      [
        'endsAt',
        'event',
        'id',
        'organization',
        'room',
        'startsAt',
        'status',
        'timezone',
        'venue',
      ].sort(),
    );
    expect(out.startsAt).toBe('2026-10-09T19:00:00.000Z');
    expect(out.venue).toEqual({ name: 'Hall', city: 'Sydney', country: 'AU' });
  });
});

describe('admin calendar: who may ask', () => {
  function contextFor(roles: string[]): ExecutionContext {
    return {
      getHandler: () => AdminEventsController.prototype.calendar,
      getClass: () => AdminEventsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', roles } }) }),
    } as unknown as ExecutionContext;
  }

  it.each([['CUSTOMER'], ['ORGANIZER_OWNER'], ['ORGANIZER_MANAGER']])(
    'refuses %s with a 403',
    (role) => {
      const guard = new RolesGuard(new Reflector());
      expect(statusOf(() => guard.canActivate(contextFor([role])))).toBe(403);
    },
  );

  it('needs the same duty as the moderation queue', async () => {
    // An ADMIN holding every duty except EVENT_REVIEW is refused.
    const prisma = {
      adminGrant: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { permission: AdminPermission.BOOKING_READ },
            { permission: AdminPermission.FINANCE_READ },
          ]),
      },
    };
    const guard = new AdminPermissionGuard(new Reflector(), prisma as never);
    await expect(guard.canActivate(contextFor(['ADMIN']))).rejects.toMatchObject({
      status: 403,
    });

    prisma.adminGrant.findMany.mockResolvedValue([{ permission: AdminPermission.EVENT_REVIEW }]);
    await expect(guard.canActivate(contextFor(['ADMIN']))).resolves.toBe(true);
  });
});
