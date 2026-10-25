import { FeedbackKind } from '@eticketsgo/shared-types';
import {
  assignSupportReference,
  canonicalSupportReference,
  formatSupportReference,
  supportReferenceScope,
  supportReferenceYear,
} from './support-reference';
import { SupportService } from './support.service';

/**
 * Readable support references, without a database: the format, the year boundary, the search
 * forms an admin may type, and that submit() takes the number inside its own transaction and
 * returns it. The counter's concurrency and the migration's backfill need real Postgres and are
 * in support-reference.integration-postgres.spec.ts.
 */
describe('support reference format', () => {
  it('is ETG-SUP-<YEAR>-<six digits>, and grows past six digits rather than being cut', () => {
    expect(formatSupportReference(2026, 1)).toBe('ETG-SUP-2026-000001');
    expect(formatSupportReference(2026, 142)).toBe('ETG-SUP-2026-000142');
    expect(formatSupportReference(2026, 999_999)).toBe('ETG-SUP-2026-999999');
    expect(formatSupportReference(2026, 1_000_000)).toBe('ETG-SUP-2026-1000000');
  });

  it('numbers by the UTC year: 31 Dec 23:59:59 UTC is the old year, 1 Jan 00:00 UTC the new', () => {
    expect(supportReferenceYear(new Date('2026-12-31T23:59:59.999Z'))).toBe(2026);
    expect(supportReferenceYear(new Date('2027-01-01T00:00:00.000Z'))).toBe(2027);
    // 05:29 on 1 January in India is still 31 December in UTC.
    expect(supportReferenceYear(new Date('2027-01-01T05:29:00+05:30'))).toBe(2026);
    expect(supportReferenceScope(2027)).toBe('SUP-2027');
  });
});

describe('assignSupportReference', () => {
  it('asks the database counter for the scope of the UTC year and formats its answer', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ value: 7 }]) };
    const ref = await assignSupportReference(tx as never, new Date('2026-12-31T23:59:59Z'));
    expect(ref).toBe('ETG-SUP-2026-000007');
    // A tagged template: the scope is a bound parameter, never spliced into the SQL.
    const [strings, scope] = tx.$queryRaw.mock.calls[0];
    expect(strings.join('?')).toContain('"etg_next_reference_value"(?)');
    expect(scope).toBe('SUP-2026');

    tx.$queryRaw.mockResolvedValueOnce([{ value: 1 }]);
    expect(await assignSupportReference(tx as never, new Date('2027-01-01T00:00:00Z'))).toBe(
      'ETG-SUP-2027-000001',
    );
    expect(tx.$queryRaw.mock.calls[1][1]).toBe('SUP-2027');
  });

  it('refuses rather than inventing a number when the counter answers nothing', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    await expect(assignSupportReference(tx as never, new Date())).rejects.toThrow(/counter/);
  });
});

describe('canonicalSupportReference (what an admin may type into the search)', () => {
  it.each([
    ['ETG-SUP-2026-000142', 'ETG-SUP-2026-000142'],
    ['etg-sup-2026-000142', 'ETG-SUP-2026-000142'],
    ['  ETGSUP2026000142 ', 'ETG-SUP-2026-000142'],
    ['ETG SUP 2026 000142', 'ETG-SUP-2026-000142'],
    ['ETG-SUP-2026-142', 'ETG-SUP-2026-000142'],
  ])('%s -> %s', (typed, canonical) => {
    expect(canonicalSupportReference(typed)).toBe(canonical);
  });

  it.each(['cmvncaxg10015uo2zxo94825e', 'ETG-IND-2026-000076', 'refund', 'ETG-SUP-2026', ''])(
    'is not a reference: %s',
    (typed) => {
      expect(canonicalSupportReference(typed)).toBeNull();
    },
  );
});

function serviceWith(over: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    feedback: {
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'cmvncaxg10015uo2zxo94825e',
          reference: data.reference,
          status: 'OPEN',
        }),
      ),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    booking: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn() },
    organization: { findMany: jest.fn().mockResolvedValue([]) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([{ value: 142 }]),
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prisma)
        : Promise.resolve([0, []]),
    ),
    ...over,
  };
  return { service: new SupportService(prisma as never), prisma };
}

describe('SupportService.submit and the reference', () => {
  it('writes the reference and the createdAt it was numbered from, and returns id AND reference', async () => {
    const { service, prisma } = serviceWith();
    const res = await service.submit(undefined, {
      kind: FeedbackKind.CONTACT,
      email: 'asha@gmail.com',
      message: 'Where are my tickets?',
    });
    expect(res).toEqual({
      id: 'cmvncaxg10015uo2zxo94825e',
      reference: `ETG-SUP-${new Date().getUTCFullYear()}-000142`,
      status: 'OPEN',
    });
    const { data, select } = prisma.feedback.create.mock.calls[0][0];
    expect(data.reference).toBe(res.reference);
    expect(data.createdAt).toBeInstanceOf(Date);
    expect(String(data.createdAt.getUTCFullYear())).toBe(res.reference!.split('-')[2]);
    expect(select).toEqual({ id: true, reference: true, status: true });
    // The counter is read inside the submission's transaction, after the duplicate check.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('a resend within the window returns the FIRST message and its reference; no new number', async () => {
    const { service, prisma } = serviceWith();
    prisma.feedback.findFirst.mockResolvedValueOnce({
      id: 'first',
      reference: 'ETG-SUP-2026-000141',
      status: 'OPEN',
    });
    const res = await service.submit(undefined, {
      kind: FeedbackKind.CONTACT,
      email: 'asha@gmail.com',
      message: 'Where are my tickets?',
    });
    expect(res).toEqual({ id: 'first', reference: 'ETG-SUP-2026-000141', status: 'OPEN' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.feedback.create).not.toHaveBeenCalled();
  });
});

describe('SupportService.list finds a request by reference or by its historical id', () => {
  async function orFor(q: string) {
    const { service, prisma } = serviceWith();
    await service.list({ page: 1, pageSize: 20, q });
    return prisma.feedback.findMany.mock.calls[0][0].where.OR;
  }

  it('the readable reference, typed loosely, matches its canonical form exactly', async () => {
    const or = await orFor('etgsup2026000142');
    expect(or).toContainEqual({
      reference: { equals: 'ETG-SUP-2026-000142', mode: 'insensitive' },
    });
  });

  it('the database id quoted in mails sent before references still matches by id', async () => {
    const or = await orFor('cmvncaxg10015uo2zxo94825e');
    expect(or).toContainEqual({ id: 'cmvncaxg10015uo2zxo94825e' });
  });

  it('a part of a reference finds the requests that contain it', async () => {
    const or = await orFor('2026-0001');
    expect(or).toContainEqual({ reference: { contains: '2026-0001', mode: 'insensitive' } });
  });

  it('rows carry their reference to the console', async () => {
    const { service, prisma } = serviceWith();
    prisma.feedback.findMany.mockResolvedValueOnce([
      {
        id: 'cm1',
        reference: 'ETG-SUP-2026-000001',
        kind: 'CONTACT',
        status: 'OPEN',
        email: null,
        subject: null,
        message: 'm',
        rating: null,
        metadata: null,
        userId: null,
        user: null,
        organizationId: null,
        bookingId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    prisma.$transaction.mockImplementationOnce((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(prisma),
    );
    const res = await service.list({ page: 1, pageSize: 20 });
    expect(res.data[0]).toEqual(
      expect.objectContaining({ id: 'cm1', reference: 'ETG-SUP-2026-000001' }),
    );
  });
});
