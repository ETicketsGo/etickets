import { RefundsService } from './refunds.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Tenant scoping for the organizer refund list.
 *
 * `adminList` is deliberately unscoped — it is the platform's queue. The bug this file
 * exists to prevent is an organizer-facing endpoint that reuses it, or that filters results
 * after the query instead of inside it. Both would leak one seller's refunds to another.
 */
function setup(opts: { memberOf?: string } = {}) {
  const count = jest.fn().mockResolvedValue(0);
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    refund: { count, findMany },
    // The service passes both queries to $transaction; resolve them for real so the
    // arguments the queries were BUILT with are what we assert on.
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  const assertMember = jest.fn(async (_u: unknown, orgId: string) => {
    if (opts.memberOf && orgId !== opts.memberOf) throw new Error('TENANT_FORBIDDEN');
  });
  const access = { assertMember, isPlatformAdmin: () => false };
  const service = new RefundsService(
    prisma as never,
    {} as never,
    {} as never,
    access as never,
    { record: jest.fn() } as never,
    { send: jest.fn() } as never,
    new MetricsService(),
    { issueCreditNote: jest.fn() } as never,
  );
  return { service, findMany, count, assertMember };
}

const USER = { id: 'u-1', email: 'o@t.test', fullName: 'O', roles: [] } as never;

describe('RefundsService.listForOrganization', () => {
  it('puts the organization filter in the query, not in a post-filter', async () => {
    const { service, findMany, count } = setup();
    await service.listForOrganization(USER, 'org-a', {});
    expect(findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org-a' });
    // The count must carry the same filter, or the pagination totals advertise the
    // existence of other tenants' rows even when none of them are returned.
    expect(count.mock.calls[0][0].where).toEqual({ organizationId: 'org-a' });
  });

  it('refuses before querying when the caller is not a member', async () => {
    const { service, findMany, assertMember } = setup({ memberOf: 'org-a' });
    await expect(service.listForOrganization(USER, 'org-b', {})).rejects.toThrow(
      'TENANT_FORBIDDEN',
    );
    expect(assertMember).toHaveBeenCalledWith(USER, 'org-b');
    // Nothing was read. An authorization check that runs after the query has already
    // loaded the other tenant's rows into memory.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('keeps the organization filter when a status filter is added', async () => {
    const { service, findMany } = setup();
    await service.listForOrganization(USER, 'org-a', { status: 'REQUESTED' as never });
    expect(findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-a',
      status: 'REQUESTED',
    });
  });

  it('caps page size so a caller cannot request the whole table', async () => {
    const { service, findMany } = setup();
    await service.listForOrganization(USER, 'org-a', { pageSize: 100_000 });
    expect(findMany.mock.calls[0][0].take).toBe(100);
  });
});
