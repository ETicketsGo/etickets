import { PrismaService } from '../../../prisma/prisma.service';
import { ProcessedEventStore } from './processed-event.store';

function make(opts: { createThrows?: boolean; reclaimCount?: number; existing?: string } = {}) {
  const prisma = {
    processedDomainEvent: {
      create: opts.createThrows
        ? jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))
        : jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: opts.reclaimCount ?? 0 }),
      findUnique: jest.fn().mockResolvedValue(opts.existing ? { status: opts.existing } : null),
    },
  } as unknown as PrismaService;
  return { store: new ProcessedEventStore(prisma), prisma };
}

describe('ProcessedEventStore.claim', () => {
  it('CLAIMED for a brand-new (eventId, handler)', async () => {
    const { store } = make();
    expect(await store.claim('e1', 'h1')).toBe('CLAIMED');
  });

  it('ALREADY_COMPLETED when a completed row exists (idempotent skip)', async () => {
    const { store } = make({ createThrows: true, reclaimCount: 0, existing: 'COMPLETED' });
    expect(await store.claim('e1', 'h1')).toBe('ALREADY_COMPLETED');
  });

  it('re-CLAIMS a previously FAILED row for retry', async () => {
    const { store } = make({ createThrows: true, reclaimCount: 1 });
    expect(await store.claim('e1', 'h1')).toBe('CLAIMED');
  });

  it('IN_PROGRESS when another worker holds a PROCESSING row (concurrent-once)', async () => {
    const { store } = make({ createThrows: true, reclaimCount: 0, existing: 'PROCESSING' });
    expect(await store.claim('e1', 'h1')).toBe('IN_PROGRESS');
  });
});
