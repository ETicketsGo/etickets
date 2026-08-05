import type { PrismaService } from '../../prisma/prisma.service';
import { CompensationRepository } from './compensation.repository';
import { CompensationState } from './compensation-state';
import { CompensationType, type CompensationAction } from './compensation-types';

const action: CompensationAction = {
  compensationType: CompensationType.REDIS_LOCK_RELEASE,
  reasonCode: 'X',
  targetReference: 'lock1',
  autoExecutable: true,
};

describe('CompensationRepository idempotency + concurrency', () => {
  it('derives a stable idempotency key from (booking, type, target, generation)', () => {
    const k1 = CompensationRepository.idempotencyKey('b1', 'REDIS_LOCK_RELEASE', 'lock1', 1);
    const k2 = CompensationRepository.idempotencyKey('b1', 'REDIS_LOCK_RELEASE', 'lock1', 1);
    const k3 = CompensationRepository.idempotencyKey('b1', 'REDIS_LOCK_RELEASE', 'lock1', 2);
    expect(k1).toEqual(k2);
    expect(k1).not.toEqual(k3);
  });

  it('createOrGet returns the existing record when a concurrent create hits the unique constraint', async () => {
    const existing = { id: 'c1', state: 'PLANNED' };
    const prisma = {
      bookingCompensation: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        findUnique: jest.fn().mockResolvedValue(existing),
      },
    } as unknown as PrismaService;
    const repo = new CompensationRepository(prisma);
    const res = await repo.createOrGet(action, { bookingId: 'b1' });
    expect(res.created).toBe(false);
    expect(res.compensation).toBe(existing);
  });

  it('advance applies a guarded transition and returns the updated row on a won race', async () => {
    const updated = { id: 'c1', state: 'READY', version: 1 };
    const prisma = {
      bookingCompensation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(updated),
      },
    } as unknown as PrismaService;
    const repo = new CompensationRepository(prisma);
    const res = await repo.advance(
      { id: 'c1', state: CompensationState.PLANNED, version: 0 } as never,
      CompensationState.READY,
    );
    expect(res).toBe(updated);
  });

  it('advance returns null on a lost race (guarded update matched no row)', async () => {
    const prisma = {
      bookingCompensation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaService;
    const repo = new CompensationRepository(prisma);
    const res = await repo.advance(
      { id: 'c1', state: CompensationState.READY, version: 0 } as never,
      CompensationState.PROCESSING,
    );
    expect(res).toBeNull();
  });

  it('dead-letters once attempts are exhausted instead of retrying', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      bookingCompensation: {
        updateMany,
        findUnique: jest.fn().mockResolvedValue({ id: 'c1', state: 'DEAD_LETTERED' }),
      },
    } as unknown as PrismaService;
    const repo = new CompensationRepository(prisma);
    const res = await repo.scheduleRetryOrDeadLetter(
      {
        id: 'c1',
        state: CompensationState.PROCESSING,
        version: 0,
        attemptCount: 5,
        maxAttempts: 5,
      } as never,
      30,
      'ERR',
    );
    expect((res as { state: string }).state).toBe('DEAD_LETTERED');
  });
});
