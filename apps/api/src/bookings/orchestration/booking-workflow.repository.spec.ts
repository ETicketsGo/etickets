import type { BookingWorkflow } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BookingWorkflowRepository } from './booking-workflow.repository';
import { BookingWorkflowState as WS } from './booking-workflow-state';
import {
  BookingIdempotencyConflictError,
  BookingWorkflowConflictError,
} from './booking-orchestrator.errors';
import { InvalidBookingTransitionError } from './booking-orchestrator.errors';

const wf = (over: Partial<BookingWorkflow> = {}): BookingWorkflow =>
  ({
    id: 'wf1',
    bookingId: 'pending-idem1',
    workflowType: 'BOOKING',
    state: WS.DRAFT,
    version: 0,
    requestFingerprint: 'fp1',
    inventoryOwnershipMode: 'LOCAL_AUTHORITATIVE',
    ...over,
  }) as BookingWorkflow;

function make(over: Record<string, jest.Mock> = {}) {
  const prisma = {
    bookingWorkflow: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      ...over,
    },
  } as unknown as PrismaService;
  return { repo: new BookingWorkflowRepository(prisma), prisma };
}

const base = {
  idempotencyKey: 'idem1',
  requestFingerprint: 'fp1',
  inventoryOwnershipMode: 'LOCAL_AUTHORITATIVE' as const,
  selectedProviderCode: 'direct',
};

describe('BookingWorkflowRepository.createOrGet (idempotency)', () => {
  it('creates a new workflow when the key is unseen', async () => {
    const { repo, prisma } = make();
    (prisma.bookingWorkflow.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.bookingWorkflow.create as jest.Mock).mockResolvedValue(wf());
    const res = await repo.createOrGet(base);
    expect(res.created).toBe(true);
  });

  it('returns the existing workflow for the same key + same fingerprint', async () => {
    const { repo, prisma } = make();
    (prisma.bookingWorkflow.findUnique as jest.Mock).mockResolvedValue(
      wf({ requestFingerprint: 'fp1' }),
    );
    const res = await repo.createOrGet(base);
    expect(res.created).toBe(false);
  });

  it('throws IdempotencyConflict for the same key + different fingerprint', async () => {
    const { repo, prisma } = make();
    (prisma.bookingWorkflow.findUnique as jest.Mock).mockResolvedValue(
      wf({ requestFingerprint: 'other' }),
    );
    await expect(repo.createOrGet(base)).rejects.toBeInstanceOf(BookingIdempotencyConflictError);
  });
});

describe('BookingWorkflowRepository.advance (optimistic concurrency)', () => {
  it('ADVANCED when the guarded update wins (version + state matched)', async () => {
    const { repo, prisma } = make();
    (prisma.bookingWorkflow.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.bookingWorkflow.findUnique as jest.Mock).mockResolvedValue(
      wf({ state: WS.INVENTORY_RESOLVED, version: 1 }),
    );
    const res = await repo.advance(wf(), WS.INVENTORY_RESOLVED);
    expect(res.outcome).toBe('ADVANCED');
    expect(prisma.bookingWorkflow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wf1', version: 0, state: WS.DRAFT } }),
    );
  });

  it('REPLAY when the row is already in the target state (idempotent)', async () => {
    const { repo, prisma } = make();
    (prisma.bookingWorkflow.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.bookingWorkflow.findUnique as jest.Mock).mockResolvedValue(
      wf({ state: WS.INVENTORY_RESOLVED }),
    );
    const res = await repo.advance(wf(), WS.INVENTORY_RESOLVED);
    expect(res.outcome).toBe('REPLAY');
  });

  it('conflicts when another worker advanced to a DIFFERENT state', async () => {
    const { repo, prisma } = make();
    (prisma.bookingWorkflow.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.bookingWorkflow.findUnique as jest.Mock).mockResolvedValue(wf({ state: WS.FAILED }));
    await expect(repo.advance(wf(), WS.INVENTORY_RESOLVED)).rejects.toBeInstanceOf(
      BookingWorkflowConflictError,
    );
  });

  it('same-state advance is an idempotent no-op (no update)', async () => {
    const { repo, prisma } = make();
    const res = await repo.advance(wf({ state: WS.LOCKED }), WS.LOCKED);
    expect(res.outcome).toBe('REPLAY');
    expect(prisma.bookingWorkflow.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an illegal transition before touching the DB', async () => {
    const { repo, prisma } = make();
    await expect(repo.advance(wf({ state: WS.DRAFT }), WS.CONFIRMED)).rejects.toBeInstanceOf(
      InvalidBookingTransitionError,
    );
    expect(prisma.bookingWorkflow.updateMany).not.toHaveBeenCalled();
  });
});
