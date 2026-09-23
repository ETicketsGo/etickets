import 'reflect-metadata';
import { FeedbackKind } from '@eticketsgo/shared-types';
import { submitFeedbackSchema } from '@eticketsgo/validation';
import { SupportService } from './support.service';

/**
 * Complaints about an organizer.
 *
 * ── THE PROPERTY WORTH A TEST ──────────────────────────────────────────────────────
 * The organizer a complaint counts against is DERIVED from the booking, never taken from the
 * request. If the request could name it, anybody could file complaints against a seller they never
 * bought from - and the count an admin reads before deciding whether that seller keeps selling
 * would be something a stranger could inflate.
 *
 * The second property is that nothing is lost when the booking cannot be found. Somebody
 * mistyping a reference still has a grievance; it is recorded and read, just not attributed.
 */
function makeService(over: Record<string, unknown> = {}) {
  const prisma = {
    feedback: {
      create: jest.fn().mockResolvedValue({ id: 'f1', status: 'OPEN' }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    booking: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn() },
    organization: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    ...over,
  };
  return { service: new SupportService(prisma as never), prisma };
}

describe('filing a complaint', () => {
  it('takes the organizer from the booking, not from the request', async () => {
    const { service, prisma } = makeService({
      booking: {
        findUnique: jest.fn().mockResolvedValue({ id: 'bk-1', organizationId: 'org-real' }),
      },
    });

    await service.submit(undefined, {
      kind: FeedbackKind.COMPLAINT,
      message: 'The show started an hour late and nobody told us.',
      email: 'ada@example.test',
      bookingId: 'bk-1',
    } as never);

    expect(prisma.feedback.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: 'org-real', bookingId: 'bk-1' }),
      }),
    );
  });

  it('has no field for an organizer at all, so one cannot be smuggled in', () => {
    const parsed = submitFeedbackSchema.parse({
      kind: 'COMPLAINT',
      message: 'Something went wrong.',
      email: 'ada@example.test',
      organizationId: 'org-someone-else',
    });

    expect(parsed).not.toHaveProperty('organizationId');
  });

  it('records a complaint whose booking cannot be found, unattributed', async () => {
    const { service, prisma } = makeService();

    await service.submit(undefined, {
      kind: FeedbackKind.COMPLAINT,
      message: 'I cannot find my booking but the event never happened.',
      email: 'ada@example.test',
      bookingId: 'typo',
    } as never);

    expect(prisma.feedback.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: null, bookingId: null }),
      }),
    );
  });

  it('refuses a complaint with no way to reach the person and no booking', () => {
    const result = submitFeedbackSchema.safeParse({
      kind: 'COMPLAINT',
      message: 'Nobody can answer me.',
    });

    expect(result.success).toBe(false);
  });

  it('accepts a complaint from a signed-in customer with no email typed', async () => {
    const { service, prisma } = makeService({
      booking: { findUnique: jest.fn().mockResolvedValue({ id: 'bk-1', organizationId: 'org-1' }) },
    });

    await service.submit(
      { id: 'u1', email: 'ada@example.test' } as never,
      {
        kind: FeedbackKind.COMPLAINT,
        message: 'The seat I paid for did not exist.',
        bookingId: 'bk-1',
      } as never,
    );

    expect(prisma.feedback.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'u1', email: 'ada@example.test' }),
      }),
    );
  });
});

describe('counting complaints against an organizer', () => {
  it('counts anything not closed as open, and everything ever filed as the total', async () => {
    const count = jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(7);
    const { service } = makeService({
      feedback: { count, create: jest.fn(), findMany: jest.fn() },
    });

    await expect(service.complaintCounts('org-1')).resolves.toEqual({ open: 2, total: 7 });
    expect(count.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-1',
      kind: 'COMPLAINT',
      status: { not: 'CLOSED' },
    });
  });
});

describe('the support inbox', () => {
  it('names the organizer and the booking reference on each row', async () => {
    const rows = [
      {
        id: 'f1',
        kind: 'COMPLAINT',
        status: 'OPEN',
        message: 'Late',
        organizationId: 'org-1',
        bookingId: 'bk-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        user: null,
      },
    ];
    const { service } = makeService({
      $transaction: jest.fn().mockResolvedValue([1, rows]),
      organization: { findMany: jest.fn().mockResolvedValue([{ id: 'org-1', name: 'Aurora' }]) },
      booking: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([{ id: 'bk-1', reference: 'ETG-IND-2026-000001' }]),
      },
    });

    const page = await service.list({ page: 1, pageSize: 20 } as never);

    expect(page.data[0]).toMatchObject({
      organizationName: 'Aurora',
      bookingReference: 'ETG-IND-2026-000001',
    });
  });

  it('keeps a complaint whose organizer has been deleted, because the record outlives it', async () => {
    const rows = [
      {
        id: 'f1',
        kind: 'COMPLAINT',
        status: 'OPEN',
        message: 'Late',
        organizationId: 'gone',
        bookingId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: null,
      },
    ];
    const { service } = makeService({
      $transaction: jest.fn().mockResolvedValue([1, rows]),
      organization: { findMany: jest.fn().mockResolvedValue([]) },
    });

    const page = await service.list({ page: 1, pageSize: 20 } as never);

    expect(page.data[0].organizationName).toBe('Deleted organization');
  });
});
