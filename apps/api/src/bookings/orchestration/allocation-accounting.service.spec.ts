import type { PrismaService } from '../../prisma/prisma.service';
import type { TransactionalEventPublisher } from '../../common/domain-events';
import { AppException } from '../../common/errors';
import { AllocationAccountingService } from './allocation-accounting.service';

function make(execResult = 1) {
  const markerUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(execResult),
    bookingWorkflow: { updateMany: markerUpdate },
  };
  const recordInTransaction = jest.fn().mockResolvedValue(1);
  const deliverAfterCommit = jest.fn().mockResolvedValue(undefined);
  const $transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
  const prisma = { $transaction } as unknown as PrismaService;
  const publisher = {
    recordInTransaction,
    deliverAfterCommit,
  } as unknown as TransactionalEventPublisher;
  const svc = new AllocationAccountingService(prisma, publisher);
  return { svc, tx, prisma, markerUpdate, recordInTransaction, deliverAfterCommit };
}

const heldCtx = {
  bookingId: 'b1',
  workflowId: 'wf1',
  providerCode: 'p',
  externalRef: 'alloc1',
  qty: 2,
  inventoryType: 'QUANTITY' as const,
};

describe('AllocationAccountingService.holdInTx (atomic capacity guard)', () => {
  it('records the held event when the guarded update reserves capacity', async () => {
    const { svc, tx, recordInTransaction } = make(1);
    await svc.holdInTx(tx as never, heldCtx);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(recordInTransaction).toHaveBeenCalledTimes(1);
  });

  it('throws ALLOCATION_EXHAUSTED (rolling back the hold) when the guard matches no row', async () => {
    const { svc, tx, recordInTransaction } = make(0);
    await expect(svc.holdInTx(tx as never, heldCtx)).rejects.toBeInstanceOf(AppException);
    expect(recordInTransaction).not.toHaveBeenCalled();
  });
});

describe('AllocationAccountingService confirm/release exactly-once marker', () => {
  const wf = (state = 'HELD', over: Record<string, unknown> = {}) =>
    ({
      id: 'wf1',
      bookingId: 'b1',
      inventoryOwnershipMode: 'ALLOCATED',
      allocationProviderCode: 'p',
      allocationExternalRef: 'alloc1',
      allocationHeldQty: 2,
      allocationAccountingState: state,
      correlationId: null,
      ...over,
    }) as never;

  it('confirmMove moves held→confirmed once when it wins the marker flip', async () => {
    const { svc, tx, markerUpdate, deliverAfterCommit } = make();
    markerUpdate.mockResolvedValue({ count: 1 });
    const ok = await svc.confirmMove(wf());
    expect(ok).toBe(true);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(deliverAfterCommit).toHaveBeenCalledTimes(1);
  });

  it('confirmMove is a no-op on a duplicate (marker flip loses the race)', async () => {
    const { svc, tx, markerUpdate } = make();
    markerUpdate.mockResolvedValue({ count: 0 });
    const ok = await svc.confirmMove(wf());
    expect(ok).toBe(false);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('does nothing when the workflow is not in the expected marker state', async () => {
    const { svc, prisma } = make();
    const ok = await svc.releaseHeld(wf('CONFIRMED'), 'HOLD_EXPIRED');
    expect(ok).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ignores non-ALLOCATED workflows', async () => {
    const { svc, prisma } = make();
    const ok = await svc.releaseHeld(
      wf('HELD', { inventoryOwnershipMode: 'LOCAL_AUTHORITATIVE' }),
      'X',
    );
    expect(ok).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
