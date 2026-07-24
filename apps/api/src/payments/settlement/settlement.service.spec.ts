import { SettlementService } from './settlement.service';

/** In-memory Prisma-ish stub: one settlement row + spies for the writes we assert. */
function makeDeps(overrides: {
  settlement?: Record<string, unknown> | null;
  createTransfer?: jest.Mock;
  reverseTransfer?: jest.Mock;
  claimCount?: number;
  reserveBps?: number;
}) {
  const settlementRow = overrides.settlement ?? null;
  const updated: Array<Record<string, unknown>> = [];
  const prisma = {
    settlement: {
      findUnique: jest.fn().mockResolvedValue(settlementRow),
      findFirst: jest.fn().mockResolvedValue(settlementRow),
      updateMany: jest.fn().mockResolvedValue({ count: overrides.claimCount ?? 1 }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return { ...(settlementRow ?? {}), ...data };
      }),
    },
    organizationMember: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const provider = {
    name: 'stripe',
    createTransfer: overrides.createTransfer,
    reverseTransfer: overrides.reverseTransfer,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { send: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue(overrides.reserveBps ?? 0) };
  const service = new SettlementService(
    prisma as never,
    audit as never,
    notifications as never,
    config as never,
    provider as never,
  );
  return { service, prisma, provider, audit, updated };
}

const approved = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  organizationId: 'org1',
  eventId: 'e1',
  currency: 'usd',
  status: 'APPROVED',
  grossSalesMinor: 100000,
  refundsMinor: 0,
  disputesMinor: 0,
  transferredMinor: 0,
  reserveMinor: 0,
  connectedAccountId: 'acct_1',
  providerTransferId: null,
  ...over,
});

const actor = { id: 'admin1', email: 'a@b.c', fullName: 'Admin', roles: ['ADMIN'] } as never;

describe('SettlementService.release', () => {
  it('recomputes payable (minus reserve) and transfers to the connected account', async () => {
    const createTransfer = jest.fn().mockResolvedValue({ transferId: 'tr_1', status: 'COMPLETED' });
    const { service, updated } = makeDeps({
      settlement: approved(),
      createTransfer,
      reserveBps: 1000, // 10%
    });
    await service.release(actor, 's1');
    expect(createTransfer).toHaveBeenCalledTimes(1);
    const arg = createTransfer.mock.calls[0][0];
    expect(arg.amountMinor).toBe(90000); // 100000 − 10% reserve
    expect(arg.destinationAccountId).toBe('acct_1');
    expect(arg.idempotencyKey).toContain('settlement_s1');
    const transferred = updated.find((d) => d.status === 'TRANSFERRED');
    expect(transferred).toMatchObject({
      providerTransferId: 'tr_1',
      transferredMinor: 90000,
      reserveMinor: 10000,
    });
  });

  it('is idempotent: a lost atomic claim does not transfer again', async () => {
    const createTransfer = jest.fn();
    const { service } = makeDeps({ settlement: approved(), createTransfer, claimCount: 0 });
    await service.release(actor, 's1');
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('a settlement already TRANSFERRED is a no-op', async () => {
    const createTransfer = jest.fn();
    const { service } = makeDeps({
      settlement: approved({ status: 'TRANSFERRED' }),
      createTransfer,
    });
    await service.release(actor, 's1');
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('refuses to release a non-approved settlement', async () => {
    const { service } = makeDeps({ settlement: approved({ status: 'ELIGIBLE' }) });
    await expect(service.release(actor, 's1')).rejects.toThrow(/APPROVED/);
  });

  it('deducts refunds/disputes/prior transfers before computing payable', async () => {
    const createTransfer = jest.fn().mockResolvedValue({ transferId: 'tr_2', status: 'COMPLETED' });
    const { service } = makeDeps({
      settlement: approved({ refundsMinor: 20000, disputesMinor: 5000, transferredMinor: 0 }),
      createTransfer,
    });
    await service.release(actor, 's1');
    expect(createTransfer.mock.calls[0][0].amountMinor).toBe(75000); // 100000 − 20000 − 5000
  });

  it('closes out a zero-payable settlement without a transfer', async () => {
    const createTransfer = jest.fn();
    const { service, updated } = makeDeps({
      settlement: approved({ refundsMinor: 100000 }),
      createTransfer,
    });
    await service.release(actor, 's1');
    expect(createTransfer).not.toHaveBeenCalled();
    expect(updated.find((d) => d.status === 'TRANSFERRED')?.payableMinor).toBe(0);
  });

  it('marks FAILED when the transfer throws', async () => {
    const createTransfer = jest.fn().mockRejectedValue(new Error('insufficient funds'));
    const { service, updated } = makeDeps({ settlement: approved(), createTransfer });
    await expect(service.release(actor, 's1')).rejects.toThrow(/transfer failed/i);
    expect(updated.some((d) => d.status === 'FAILED')).toBe(true);
  });
});

describe('SettlementService.applyRefund', () => {
  it('reverses the organizer share when funds already transferred', async () => {
    const reverseTransfer = jest
      .fn()
      .mockResolvedValue({ reversalId: 'trr_1', status: 'COMPLETED' });
    const { service, updated } = makeDeps({
      settlement: approved({
        status: 'TRANSFERRED',
        providerTransferId: 'tr_1',
        transferredMinor: 90000,
      }),
      reverseTransfer,
    });
    await service.applyRefund('e1', 'usd', 30000);
    expect(reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: 'tr_1', amountMinor: 30000 }),
    );
    expect(updated.some((d) => d.status === 'PARTIALLY_REFUNDED')).toBe(true);
  });

  it('only accrues refundsMinor when not yet transferred (no reversal)', async () => {
    const reverseTransfer = jest.fn();
    const { service, prisma } = makeDeps({
      settlement: approved({ status: 'ELIGIBLE' }),
      reverseTransfer,
    });
    await service.applyRefund('e1', 'usd', 30000);
    expect(reverseTransfer).not.toHaveBeenCalled();
    expect(prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { refundsMinor: { increment: 30000 } } }),
    );
  });

  it('ignores a zero/negative organizer share', async () => {
    const { service, prisma } = makeDeps({ settlement: approved() });
    await service.applyRefund('e1', 'usd', 0);
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });
});
