import { PrismaService } from '../../prisma/prisma.service';
import { SyncCheckpointService } from './sync-checkpoint.service';

function make(leaseCount: number) {
  const prisma = {
    providerSyncCheckpoint: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: leaseCount }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ cursor: 'c1' }),
    },
  } as unknown as PrismaService;
  return { service: new SyncCheckpointService(prisma), prisma };
}

describe('SyncCheckpointService', () => {
  it('acquires the lease when the conditional update wins (count 1)', async () => {
    const { service } = make(1);
    expect(await service.acquireLease('mock', '', 'changes', 300)).toBe(true);
  });

  it('does NOT acquire when the lease is held elsewhere (count 0)', async () => {
    const { service } = make(0);
    expect(await service.acquireLease('mock', '', 'changes', 300)).toBe(false);
  });

  it('advance updates cursor + clears failures', async () => {
    const { service, prisma } = make(1);
    await service.advance('mock', '', 'changes', 'next', new Date());
    expect(prisma.providerSyncCheckpoint.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cursor: 'next', failureCount: 0 }),
      }),
    );
  });
});
