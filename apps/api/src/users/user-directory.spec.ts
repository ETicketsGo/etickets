import 'reflect-metadata';
import { Role, UserStatus } from '@eticketsgo/shared-types';
import { UsersService } from './users.service';

/**
 * The account directory, and the country an account belongs to.
 *
 * ── THE DEFECT THIS LOCKS SHUT ─────────────────────────────────────────────────────
 * Role and status used to be filtered in the BROWSER, against the twenty rows already fetched. So
 * "show me the suspended accounts" returned the suspended ones among the first twenty - usually
 * none - under a pager that still counted the whole directory. The first test asserts the filter
 * reaches the database, because a filter that silently applies to a page is worse than none.
 *
 * ── AND THE ONE THING THE COUNTRY MUST NOT BECOME ──────────────────────────────────
 * A guess. A `User` has no country: nobody is asked at sign-up, a locale is a language setting,
 * and a calling code cannot tell the United States from Canada. It is derived from what the
 * account DID - venues it bought at, organizations it belongs to - and an account with neither has
 * no country, reported as such.
 */
function makeService(over: Record<string, unknown> = {}) {
  const prisma = {
    user: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    organizationMember: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...over,
  };
  return { service: new UsersService(prisma as never), prisma };
}

describe('account directory: filters reach the database', () => {
  it('asks Postgres for the role and the status, not the browser', async () => {
    const $transaction = jest.fn().mockResolvedValue([0, []]);
    const { service, prisma } = makeService({ $transaction });

    await service.list(1, 25, { role: Role.CUSTOMER, status: UserStatus.SUSPENDED, query: 'ada' });

    const where = (prisma.user.count as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ roles: { has: 'CUSTOMER' }, status: 'SUSPENDED' });
    expect(where.OR).toEqual([
      { email: { contains: 'ada', mode: 'insensitive' } },
      { fullName: { contains: 'ada', mode: 'insensitive' } },
    ]);
  });

  it('matches a country in any spelling, on either side of the account', async () => {
    const { service, prisma } = makeService();

    await service.list(1, 25, { country: 'IN' });

    const where = (prisma.user.count as jest.Mock).mock.calls[0][0].where;
    const clause = where.AND[0].OR as Record<string, never>[];
    // Bought there, or belongs to an organizer registered there.
    expect(clause).toHaveLength(2);
    const aliases = JSON.stringify(clause);
    expect(aliases).toContain('india');
    expect(aliases).toContain('in');
  });
});

describe('account directory: the country is derived, never guessed', () => {
  it('names the countries an account bought in and belongs to, folding the spellings', async () => {
    const { service } = makeService({
      $transaction: jest
        .fn()
        .mockResolvedValue([1, [{ id: 'u1', email: 'a@b.test', fullName: 'Ada', roles: [] }]]),
      $queryRaw: jest.fn().mockResolvedValue([
        { userid: 'u1', country: 'India' },
        // The same market, written the way an older venue row spells it.
        { userid: 'u1', country: 'IN' },
      ]),
      organizationMember: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ userId: 'u1', organization: { registeredCountry: 'Canada' } }]),
      },
    });

    const page = await service.list(1, 25);

    expect(page.data[0].countries).toEqual(['Canada', 'India']);
  });

  it('leaves an account with no booking and no organization with no country', async () => {
    const { service } = makeService({
      $transaction: jest
        .fn()
        .mockResolvedValue([1, [{ id: 'u2', email: 'n@b.test', fullName: 'New', roles: [] }]]),
    });

    const page = await service.list(1, 25);

    expect(page.data[0].countries).toEqual([]);
  });
});

describe('account directory: the summary', () => {
  it('folds country spellings, and its unknown count agrees with the list', async () => {
    const { service } = makeService({
      user: {
        count: jest.fn().mockResolvedValueOnce(120).mockResolvedValue(0),
        findMany: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([{ status: 'ACTIVE', _count: { _all: 120 } }]),
      },
      $queryRaw: jest
        .fn()
        // The country breakdown, then the count of accounts a country could be derived for.
        .mockResolvedValueOnce([
          { country: 'India', count: 30n },
          { country: 'IN', count: 5n },
          { country: 'Canada', count: 9n },
        ])
        .mockResolvedValueOnce([{ count: 40n }]),
    });

    const summary = await service.directorySummary();

    expect(summary.total).toBe(120);
    expect(summary.byCountry).toEqual([
      { country: 'India', count: 35 },
      { country: 'Canada', count: 9 },
    ]);
    /*
      120 accounts, 40 of them placed somewhere, so 80 are not - which is exactly the number of
      rows the list shows as "Not known". This used to count accounts with no booking AND no
      membership, a different set: the card said 1 while four rows underneath said Not known.
    */
    expect(summary.withoutCountry).toBe(80);
  });
});
