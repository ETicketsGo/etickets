import { FeedbackKind } from '@eticketsgo/shared-types';
import { submitFeedbackSchema } from '@eticketsgo/validation';
import { SupportService } from './support.service';
import { AppException } from '../common/errors';
import type { RequestUser } from '../common/decorators';

function setup() {
  const prisma = {
    feedback: {
      create: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ id: 'fb-1', status: data.status })),
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ id: 'fb-1' }),
      update: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ id: 'fb-1', status: data.status })),
    },
    $transaction: jest.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const service = new SupportService(prisma as never);
  return { service, prisma };
}

const user: RequestUser = { id: 'u1', email: 'me@eticketsgo.test', fullName: 'Me', roles: [] };

describe('SupportService.submit', () => {
  it('persists a submission with kind and rating (CSAT) and returns id/status', async () => {
    const { service, prisma } = setup();
    const res = await service.submit(user, {
      kind: FeedbackKind.CSAT,
      message: 'Loved it',
      rating: 5,
    });
    expect(res).toEqual({ id: 'fb-1', status: 'OPEN' });
    expect(prisma.feedback.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: FeedbackKind.CSAT,
          rating: 5,
          userId: 'u1',
          email: 'me@eticketsgo.test',
          status: 'OPEN',
        }),
      }),
    );
  });

  it('attaches the signed-in user id/email for a contact submission', async () => {
    const { service, prisma } = setup();
    await service.submit(user, { kind: FeedbackKind.CONTACT, message: 'Help please' });
    expect(prisma.feedback.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'u1', email: 'me@eticketsgo.test' }),
      }),
    );
  });

  it('rejects an anonymous CONTACT submission without an email', async () => {
    const { service } = setup();
    await expect(
      service.submit(undefined, { kind: FeedbackKind.CONTACT, message: 'Anon help' }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('accepts an anonymous BUG submission (no email required)', async () => {
    const { service, prisma } = setup();
    await service.submit(undefined, {
      kind: FeedbackKind.BUG,
      message: 'It broke',
      metadata: { url: 'https://x/y', userAgent: 'jest' },
    });
    expect(prisma.feedback.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: null,
          metadata: { url: 'https://x/y', userAgent: 'jest' },
        }),
      }),
    );
  });
});

describe('submitFeedbackSchema (validation layer)', () => {
  it('rejects a CSAT submission with no rating', () => {
    const r = submitFeedbackSchema.safeParse({ kind: 'CSAT', message: 'Nice' });
    expect(r.success).toBe(false);
  });

  it('rejects an ORGANIZER_CSAT submission with no rating', () => {
    const r = submitFeedbackSchema.safeParse({ kind: 'ORGANIZER_CSAT', message: 'Nice' });
    expect(r.success).toBe(false);
  });

  it('accepts a GENERAL submission with just a message', () => {
    const r = submitFeedbackSchema.safeParse({ kind: 'GENERAL', message: 'Hi' });
    expect(r.success).toBe(true);
  });
});

describe('SupportService.list', () => {
  it('filters by kind and status and searches message/subject/email', async () => {
    const { service, prisma } = setup();
    await service.list({
      page: 1,
      pageSize: 20,
      kind: FeedbackKind.BUG,
      status: 'OPEN',
      q: 'crash',
    });
    const findArgs = prisma.feedback.findMany.mock.calls[0][0];
    expect(findArgs.where.kind).toBe(FeedbackKind.BUG);
    expect(findArgs.where.status).toBe('OPEN');
    expect(findArgs.where.OR).toEqual([
      { message: { contains: 'crash', mode: 'insensitive' } },
      { subject: { contains: 'crash', mode: 'insensitive' } },
      { email: { contains: 'crash', mode: 'insensitive' } },
    ]);
  });

  it('returns a paged envelope', async () => {
    const { service } = setup();
    const res = await service.list({ page: 1, pageSize: 20 });
    expect(res.meta).toEqual({ page: 1, pageSize: 20, total: 1, totalPages: 1 });
  });
});

describe('SupportService.updateStatus', () => {
  it('updates an existing submission status', async () => {
    const { service, prisma } = setup();
    const res = await service.updateStatus('fb-1', { status: 'TRIAGED' });
    expect(res).toEqual({ id: 'fb-1', status: 'TRIAGED' });
    expect(prisma.feedback.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'fb-1' }, data: { status: 'TRIAGED' } }),
    );
  });

  it('throws when the submission does not exist', async () => {
    const { service, prisma } = setup();
    prisma.feedback.findUnique.mockResolvedValueOnce(null);
    await expect(service.updateStatus('missing', { status: 'CLOSED' })).rejects.toBeInstanceOf(
      AppException,
    );
  });
});
