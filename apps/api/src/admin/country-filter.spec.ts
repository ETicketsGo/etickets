import 'reflect-metadata';
import { z } from 'zod';
import { paginationSchema } from '@eticketsgo/validation';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppException } from '../common/errors';
import { AdminService } from './admin.service';
import { AdminGroupingService } from './admin-grouping.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { EventsService } from '../events/events.service';
import { countryFilterField, countryWhere } from './country-filter';

/**
 * The admin country filter.
 *
 * ── WHAT THESE LOCK SHUT ───────────────────────────────────────────────────────────
 *  - A country in the URL is a 2-letter code or a 400. A hand-edited `country=Inda` that was
 *    quietly ignored would show EVERY row under a heading that said India.
 *  - The code means the whole market: every stored spelling ("India", "india", "IN"), not the
 *    one spelling a grouped-summary chip happens to carry.
 *  - It is ANDed with the grouped scope, never spread over it. Both can name `venue` or
 *    `registeredCountry`, and a spread lets the later one silently erase the earlier.
 *  - The summary above a list filters by the same country, or it does not add up to the list.
 */

/** The query schema each list's controller builds, reduced to the parts under test. */
const listQuery = new ZodValidationPipe(
  paginationSchema.extend({ q: z.string().optional(), country: countryFilterField }),
);

function parse(country: unknown) {
  return listQuery.transform({ country }, { type: 'query' }) as { country?: string };
}

function status(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppException ? e.getStatus() : -1;
  }
  return undefined;
}

describe('the country query parameter', () => {
  it('accepts an ISO alpha-2 code, in either case, as upper-case', () => {
    expect(parse('IN').country).toBe('IN');
    expect(parse(' us ').country).toBe('US');
  });

  it('is optional: absent means every country', () => {
    expect(parse(undefined).country).toBeUndefined();
  });

  it.each(['India', 'IND', 'I', '1N', '', 'in;drop'])('refuses %p with a 400', (value) => {
    expect(status(() => parse(value))).toBe(400);
  });
});

describe('a country means every spelling of it', () => {
  it('matches the stored names case-insensitively', () => {
    const where = countryWhere('events', 'IN') as { venue: { country: { in: string[] } } };
    expect(where.venue.country).toMatchObject({ mode: 'insensitive' });
    expect(where.venue.country.in).toEqual(expect.arrayContaining(['in', 'india']));
  });

  it('is nothing at all when no country was asked for', () => {
    expect(countryWhere('bookings', undefined)).toBeNull();
  });
});

function prismaMock(extra: Record<string, unknown> = {}) {
  return {
    $transaction: jest.fn().mockResolvedValue([0, []]),
    feedback: { groupBy: jest.fn().mockResolvedValue([]) },
    eventSession: { groupBy: jest.fn().mockResolvedValue([]) },
    ...extra,
  };
}

const whereOf = (count: jest.Mock) => count.mock.calls[0][0].where;

describe('each list applies it in the database, beside the group scope', () => {
  it('bookings: by the venue country, ANDed with a grouped scope on the same relation', async () => {
    const count = jest.fn();
    const service = new AdminService(
      prismaMock({ booking: { count, findMany: jest.fn() } }) as never,
      {} as never,
    );

    await service.bookings({
      page: 1,
      pageSize: 15,
      country: 'IN',
      groupBy: 'country',
      groupKey: 'India',
    });

    const where = whereOf(count);
    // The grouped scope survives ...
    expect(where.event).toEqual({ venue: { country: 'India' } });
    // ... and the filter sits beside it rather than over it.
    expect(where.AND).toEqual([
      {
        event: {
          venue: { country: { in: expect.arrayContaining(['india']), mode: 'insensitive' } },
        },
      },
    ]);
  });

  it('bookings: says which country each row was sold in', async () => {
    const row = {
      id: 'b1',
      reference: 'ETG-IN-2026-000001',
      status: 'CONFIRMED',
      buyerEmail: 'a@example.com',
      totalMinor: 100,
      currency: 'INR',
      createdAt: new Date(),
      event: { title: 'Show', venue: { country: 'India' } },
      payment: null,
    };
    const findMany = jest.fn();
    const service = new AdminService(
      prismaMock({
        booking: { count: jest.fn(), findMany },
        $transaction: jest.fn().mockResolvedValue([1, [row]]),
      }) as never,
      {} as never,
    );

    const page = await service.bookings({ page: 1, pageSize: 15 });

    expect(page.data[0].country).toBe('India');
    expect(findMany.mock.calls[0][0].include.event.select.venue).toEqual({
      select: { country: true },
    });
  });

  it('events: by the venue country', async () => {
    const count = jest.fn();
    const service = new EventsService(
      prismaMock({ event: { count, findMany: jest.fn() } }) as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.adminList(undefined, 1, 15, undefined, {}, 'CA');

    expect(whereOf(count).AND).toEqual([
      { venue: { country: { in: expect.arrayContaining(['canada']), mode: 'insensitive' } } },
    ]);
  });

  it('organizers: by the registered country', async () => {
    const count = jest.fn();
    const service = new OrganizationsService(
      prismaMock({ organization: { count, findMany: jest.fn() } }) as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.adminList(undefined, 1, 15, undefined, {}, 'US');

    expect(whereOf(count).AND).toEqual([
      {
        registeredCountry: {
          in: expect.arrayContaining(['united states', 'usa']),
          mode: 'insensitive',
        },
      },
    ]);
  });

  it('leaves the list whole when no country is given', async () => {
    const count = jest.fn();
    const service = new AdminService(
      prismaMock({ booking: { count, findMany: jest.fn() } }) as never,
      {} as never,
    );

    await service.bookings({ page: 1, pageSize: 15 });

    expect(whereOf(count).AND).toBeUndefined();
  });
});

describe('the grouped summary filters by the same country as its list', () => {
  function grouping() {
    const $queryRawUnsafe = jest.fn().mockResolvedValue([]);
    return { service: new AdminGroupingService({ $queryRawUnsafe } as never), $queryRawUnsafe };
  }

  it('bookings: on the venue column, every spelling, as a bound parameter', async () => {
    const { service, $queryRawUnsafe } = grouping();

    await service.grouped('bookings', 'organizer', { country: 'IN' });

    const [sql, ...params] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('LOWER(v.country) = ANY($1::text[])');
    expect(params[0]).toEqual(expect.arrayContaining(['in', 'india']));
  });

  it('organizers: on the registered country', async () => {
    const { service, $queryRawUnsafe } = grouping();

    await service.grouped('organizers', 'country', { status: 'APPROVED', country: 'GB' });

    const [sql, ...params] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('LOWER(o."registeredCountry") = ANY($2::text[])');
    expect(params).toEqual(['APPROVED', expect.arrayContaining(['united kingdom', 'uk'])]);
  });

  it('a queue whose list takes no country ignores it, as its list does', async () => {
    const { service, $queryRawUnsafe } = grouping();

    await service.grouped('settlements', 'currency', { country: 'IN' });

    const [sql, ...params] = $queryRawUnsafe.mock.calls[0];
    expect(sql).not.toContain('ANY(');
    expect(params).toEqual([]);
  });
});

/*
  Not a country test, but the one admin RESPONSE this change masks server-side: the review
  signals name the owner's email domain, and a phone-only owner's placeholder domain is the
  platform's own. Reporting it would tell a reviewer the owner registered with an address at
  "users.eticketsgo.internal", which is false - they registered with no address at all.
*/
describe('organizer review signals: a phone-only owner has no email domain', () => {
  async function domainFor(email: string) {
    const prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'org-1',
          name: 'Aurora Events',
          status: 'PENDING',
          createdAt: new Date('2026-01-01'),
          members: [{ user: { id: 'u1', email, createdAt: new Date('2026-01-01') } }],
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new OrganizationsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const signals = await service.reviewSignals('org-1');
    return signals.owner?.emailDomain;
  }

  it('reports a real domain', async () => {
    expect(await domainFor('owner@aurora.example')).toBe('aurora.example');
  });

  it('reports none for the placeholder', async () => {
    expect(await domainFor('phone+919876543210@users.eticketsgo.internal')).toBeNull();
  });
});
