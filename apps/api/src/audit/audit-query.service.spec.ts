import 'reflect-metadata';
import { AuditQueryService } from './audit-query.service';

/**
 * The way into the audit log.
 *
 * ── WHAT THIS PROTECTS ─────────────────────────────────────────────────────────────
 * The console listed every privileged action on the platform, twenty rows to a page, filtered
 * only by action name. These tests hold the three things that made it usable: an organizer can be
 * grouped by the country they are registered in, an action with no organization is named rather
 * than dropped, and the action dropdown is built from the log instead of a list typed into a page.
 *
 * Plus the date boundary that is easy to get wrong: "to the 18th" has to include the whole of the
 * 18th, or a day's worth of audit entries silently vanishes.
 */
function makeService(over: Record<string, unknown> = {}) {
  const prisma = {
    auditLog: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    organization: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
    ...over,
  };
  return { service: new AuditQueryService(prisma as never), prisma };
}

describe('audit query: summary', () => {
  it('names the organizer and the country it is registered in', async () => {
    const { service } = makeService({
      auditLog: {
        count: jest.fn().mockResolvedValue(9),
        groupBy: jest
          .fn()
          // byOrganization, then byAction, then the dropdown's actions.
          .mockResolvedValueOnce([{ organizationId: 'org-1', _count: { _all: 7 } }])
          .mockResolvedValueOnce([{ action: 'BOOKING_CONFIRMED', _count: { _all: 7 } }])
          .mockResolvedValueOnce([{ action: 'BOOKING_CONFIRMED' }, { action: 'EVENT_CREATED' }]),
        findMany: jest.fn(),
      },
      organization: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'org-1', name: 'Aurora Live', registeredCountry: 'IN' }]),
      },
    });

    const summary = await service.summary({});

    // "IN" resolves to the market's own name, so the panel groups India once.
    expect(summary.byOrganization).toEqual([
      { organizationId: 'org-1', name: 'Aurora Live', country: 'India', count: 7 },
    ]);
    // Built from the log, so an action added anywhere in the API is filterable at once.
    expect(summary.actions).toEqual(['BOOKING_CONFIRMED', 'EVENT_CREATED']);
  });

  it('names an action with no organization as the platform, rather than dropping it', async () => {
    const { service } = makeService({
      auditLog: {
        count: jest.fn().mockResolvedValue(1),
        groupBy: jest
          .fn()
          .mockResolvedValueOnce([{ organizationId: null, _count: { _all: 1 } }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        findMany: jest.fn(),
      },
    });

    const summary = await service.summary({});

    expect(summary.byOrganization[0]).toMatchObject({ name: 'Platform', country: null });
  });

  it('keeps an organizer that has been deleted, because the log outlives it', async () => {
    const { service } = makeService({
      auditLog: {
        count: jest.fn().mockResolvedValue(1),
        groupBy: jest
          .fn()
          .mockResolvedValueOnce([{ organizationId: 'gone', _count: { _all: 3 } }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        findMany: jest.fn(),
      },
      organization: { findMany: jest.fn().mockResolvedValue([]) },
    });

    const summary = await service.summary({});

    expect(summary.byOrganization[0]).toMatchObject({
      organizationId: 'gone',
      name: 'Deleted organization',
      count: 3,
    });
  });
});

describe('audit query: filters', () => {
  it('covers the whole of the last day a date-only filter names', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const { service } = makeService({
      auditLog: {
        count,
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn(),
      },
    });

    await service.summary({ from: '2026-09-18', to: '2026-09-18' });

    const where = count.mock.calls[0][0].where as {
      createdAt: { gte: Date; lte: Date };
    };
    expect(where.createdAt.gte.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    // Not midnight: a naive parse would drop the whole day's entries.
    expect(where.createdAt.lte.toISOString()).toBe('2026-09-18T23:59:59.999Z');
  });

  it('narrows to one organizer when asked', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const { service } = makeService({
      auditLog: { count, groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn() },
    });

    await service.summary({ organizationId: 'org-9', entityType: 'Payout' });

    expect(count.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-9',
      entityType: 'Payout',
    });
  });
});

describe('audit query: list', () => {
  it('names the organization on each row instead of returning its id alone', async () => {
    const rows = [
      {
        id: 'a1',
        action: 'PAYOUT_PAID',
        organizationId: 'org-1',
        createdAt: new Date('2026-09-18T10:00:00.000Z'),
      },
    ];
    const { service } = makeService({
      $transaction: jest.fn().mockResolvedValue([1, rows]),
      organization: {
        findMany: jest.fn().mockResolvedValue([{ id: 'org-1', name: 'Aurora Live' }]),
      },
    });

    const page = await service.list({}, 1, 20);

    expect(page.data[0]).toMatchObject({ organizationName: 'Aurora Live' });
    expect(page.meta).toMatchObject({ page: 1, pageSize: 20, total: 1, totalPages: 1 });
  });
});
