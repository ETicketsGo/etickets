import { SettlementService } from './settlement.service';

/** In-memory Prisma-ish stub: one settlement row + spies for the writes we assert. */
function makeDeps(overrides: {
  settlement?: Record<string, unknown> | null;
  createTransfer?: jest.Mock;
  reverseTransfer?: jest.Mock;
  claimCount?: number;
  /** Reversal attempts already on the settlement, as the clamp would read them. */
  priorAttempts?: Array<{ status: string; requestedMinor: number; confirmedMinor: number }>;
  /** 0 simulates another worker having already settled the attempt. */
  attemptClaimCount?: number;
  reserveBps?: number;
  ledgerPayouts?: Array<Record<string, unknown>>;
}) {
  const settlementRow = overrides.settlement ?? null;
  const updated: Array<Record<string, unknown>> = [];
  /** Attempt rows the service creates, so a test can assert what was recorded. */
  const attempts: Array<Record<string, unknown>> = [];
  const prisma = {
    /*
      The reversal ledger. The service now writes an attempt BEFORE calling the provider and
      updates it from what the provider proved, so a stub without this model makes every
      reversal path throw rather than exercise the behaviour under test.
    */
    settlementReversalAttempt: {
      findMany: jest.fn(async () => overrides.priorAttempts ?? []),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `att_${attempts.length + 1}`, ...data };
        attempts.push(row);
        return row;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        attempts.push({ op: 'update', ...data });
        return data;
      }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        attempts.push({ op: 'updateMany', ...data });
        return { count: overrides.attemptClaimCount ?? 1 };
      }),
    },
    settlement: {
      findUnique: jest.fn().mockResolvedValue(settlementRow),
      findFirst: jest.fn().mockResolvedValue(settlementRow),
      updateMany: jest.fn().mockResolvedValue({ count: overrides.claimCount ?? 1 }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return { ...(settlementRow ?? {}), ...data };
      }),
    },
    // Read by `release` to refuse a transfer the PAYOUT LEDGER has already claimed. Empty is
    // the ordinary case: no ledger payout covers this event.
    payout: { findMany: jest.fn().mockResolvedValue(overrides.ledgerPayouts ?? []) },
    organizationMember: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    // The release and the organizer being told about it are now one transaction, so the
    // payout notice cannot be lost in the window between the two writes.
    $transaction: undefined as unknown as (fn: (tx: unknown) => unknown) => unknown,
  };
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
  const provider = {
    name: 'stripe',
    createTransfer: overrides.createTransfer,
    reverseTransfer: overrides.reverseTransfer,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = {
    send: jest.fn().mockResolvedValue(undefined),
    // Critical notifications are written IN the domain transaction now, so the stub
    // captures the transaction client it was handed -- that IS the assertion.
    sendCritical: jest.fn().mockResolvedValue(undefined),
    fanOutCritical: jest.fn().mockResolvedValue(0),
  };
  const config = { get: jest.fn().mockReturnValue(overrides.reserveBps ?? 0) };
  // SettlementService now resolves the transfer adapter by provider name.
  const resolver = { get: jest.fn().mockReturnValue(provider) };
  const service = new SettlementService(
    prisma as never,
    audit as never,
    notifications as never,
    config as never,
    resolver as never,
  );
  return { service, prisma, provider, audit, updated, attempts };
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

  it('refuses when the payout ledger has already claimed this revenue', async () => {
    /*
      ── THE DOUBLE PAYMENT THIS PREVENTS ─────────────────────────────────────────────
      This platform can pay an organizer twice over: a provider transfer here, and the
      `Payout` ledger, which is settled by a bank transfer somebody makes by hand. Nothing
      connected the two, so an event could be transferred AND recorded as owed, and the
      second payment would look exactly like the first.
    */
    const createTransfer = jest.fn();
    const { service, prisma } = makeDeps({
      settlement: approved(),
      createTransfer,
      ledgerPayouts: [{ id: 'po_1', status: 'PAID', eventId: 'e1', netMinor: 100000 }],
    });

    await expect(service.release(actor, 's1')).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { payoutIds: ['po_1'] },
    });
    expect(createTransfer).not.toHaveBeenCalled();
    // Refused BEFORE the atomic claim, so the settlement is not left in TRANSFER_PROCESSING
    // for an operator to unpick.
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it('transfers when no payout covers it', async () => {
    const createTransfer = jest.fn().mockResolvedValue({ transferId: 'tr_9', status: 'COMPLETED' });
    const { service } = makeDeps({ settlement: approved(), createTransfer, ledgerPayouts: [] });
    await service.release(actor, 's1');
    expect(createTransfer).toHaveBeenCalledTimes(1);
  });
});

describe('SettlementService.applyRefund', () => {
  it('reverses the organizer share, and records what the provider confirmed', async () => {
    const reverseTransfer = jest.fn().mockResolvedValue({
      kind: 'CONFIRMED',
      reversalId: 'trr_1',
      confirmedMinor: 30000,
      raw: { id: 'trr_1' },
    });
    const { service, updated, attempts } = makeDeps({
      settlement: approved({
        status: 'TRANSFERRED',
        providerTransferId: 'tr_1',
        transferredMinor: 90000,
        releasedMinor: 90000,
      }),
      reverseTransfer,
    });
    await service.applyRefund('e1', 'usd', 30000);

    expect(reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: 'tr_1', amountMinor: 30000 }),
    );
    // The attempt is written BEFORE the call, and settled from the answer.
    expect(attempts[0]).toMatchObject({ status: 'REQUESTED', requestedMinor: 30000 });
    expect(attempts.some((a) => a.status === 'COMPLETED' && a.confirmedMinor === 30000)).toBe(true);
    // Money moves, and only here.
    expect(updated.some((d) => JSON.stringify(d).includes('decrement'))).toBe(true);
    /*
      The settlement status is NOT set to PARTIALLY_REFUNDED any more. It is derived from
      confirmed amounts, which is what makes a partial reversal structurally unable to read as a
      full one.
    */
    expect(updated.some((d) => d.status === 'PARTIALLY_REFUNDED')).toBe(false);
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

  /*
    ── THE DEFECT FROM #170, NOW FIXED ──────────────────────────────────────
    These two tests used to assert the defect: a refund arriving after a partial reversal was
    accrued into `refundsMinor` and never clawed back, because `reverseIfTransferred` reversed
    only while the status was EXACTLY 'TRANSFERRED'. They were written to fail the moment the
    behaviour changed, so that fixing it had to be deliberate.

    This is that moment. The guard is gone: what may be reversed is now decided by how much the
    organizer still holds - released minus what reversals have CONFIRMED - not by a status
    string. So a second refund is attempted like any other.
  */
  it('reverses a refund that arrives AFTER a partial reversal', async () => {
    const reverseTransfer = jest.fn().mockResolvedValue({
      kind: 'CONFIRMED',
      reversalId: 'trr_2',
      confirmedMinor: 20000,
      raw: {},
    });
    const { service, attempts } = makeDeps({
      settlement: approved({
        status: 'PARTIALLY_REFUNDED',
        providerTransferId: 'tr_1',
        transferredMinor: 60000,
        releasedMinor: 90000,
        refundsMinor: 30000,
      }),
      // 30000 already confirmed, so 60000 of the 90000 released is still with the organizer.
      priorAttempts: [{ status: 'COMPLETED', requestedMinor: 30000, confirmedMinor: 30000 }],
      reverseTransfer,
    });

    await service.applyRefund('e1', 'usd', 20000);

    expect(reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: 'tr_1', amountMinor: 20000 }),
    );
    expect(attempts[0]).toMatchObject({ status: 'REQUESTED', requestedMinor: 20000 });
  });

  it('cannot ask for more than the organizer still holds', async () => {
    /*
      The clamp that replaces the status guard. 90000 was released and 70000 is already
      confirmed back, so only 20000 remains however large the refund is.
    */
    const reverseTransfer = jest.fn().mockResolvedValue({
      kind: 'CONFIRMED',
      reversalId: 'trr_3',
      confirmedMinor: 20000,
      raw: {},
    });
    const { service } = makeDeps({
      settlement: approved({
        status: 'PARTIALLY_REFUNDED',
        providerTransferId: 'tr_1',
        transferredMinor: 20000,
        releasedMinor: 90000,
      }),
      priorAttempts: [{ status: 'COMPLETED', requestedMinor: 70000, confirmedMinor: 70000 }],
      reverseTransfer,
    });

    await service.applyRefund('e1', 'usd', 50000);

    expect(reverseTransfer).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 20000 }));
  });

  it('attempts nothing once everything has come back', async () => {
    const reverseTransfer = jest.fn();
    const { service } = makeDeps({
      settlement: approved({
        status: 'REVERSED',
        providerTransferId: 'tr_1',
        transferredMinor: 0,
        releasedMinor: 90000,
      }),
      priorAttempts: [{ status: 'COMPLETED', requestedMinor: 90000, confirmedMinor: 90000 }],
      reverseTransfer,
    });

    await service.applyRefund('e1', 'usd', 10000);

    expect(reverseTransfer).not.toHaveBeenCalled();
  });

  /*
    ── R3: A FAILED CLAWBACK IS NOW FINDABLE ──────────────────────────────────
    Before, a failed reversal logged a line, notified admins and returned normally - while
    `refundsMinor` had already been incremented. Nothing in the database recorded the attempt, so
    reconciliation could not find it. These prove the row exists and that no money moved.
  */
  it('records an authoritative refusal as FAILED, and moves no money', async () => {
    const reverseTransfer = jest.fn().mockResolvedValue({
      kind: 'REFUSED',
      code: 'balance_insufficient',
      message: 'insufficient balance',
      retryable: false,
      raw: {},
    });
    const { service, updated, attempts } = makeDeps({
      settlement: approved({
        status: 'TRANSFERRED',
        providerTransferId: 'tr_1',
        transferredMinor: 90000,
        releasedMinor: 90000,
      }),
      reverseTransfer,
    });

    await service.applyRefund('e1', 'usd', 30000);

    expect(
      attempts.some((a) => a.status === 'FAILED' && a.lastError === 'insufficient balance'),
    ).toBe(true);
    expect(updated.some((d) => JSON.stringify(d).includes('decrement'))).toBe(false);
  });

  it('records an ambiguous outcome as UNKNOWN, which is NOT a failure', async () => {
    /*
      A timeout is not a failure: the provider may have moved money while our answer was lost.
      UNKNOWN is non-terminal so reconciliation asks what happened, and it must never be
      confused with the authoritative refusal above.
    */
    const reverseTransfer = jest.fn().mockResolvedValue({ kind: 'INDETERMINATE', raw: {} });
    const { service, updated, attempts } = makeDeps({
      settlement: approved({
        status: 'TRANSFERRED',
        providerTransferId: 'tr_1',
        transferredMinor: 90000,
        releasedMinor: 90000,
      }),
      reverseTransfer,
    });

    await service.applyRefund('e1', 'usd', 30000);

    expect(attempts.some((a) => a.status === 'UNKNOWN')).toBe(true);
    expect(attempts.some((a) => a.status === 'FAILED')).toBe(false);
    expect(updated.some((d) => JSON.stringify(d).includes('decrement'))).toBe(false);
  });

  it('treats an adapter that THROWS as unknown, never as failed', async () => {
    // An exception says nothing about whether the provider acted.
    const reverseTransfer = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const { service, updated, attempts } = makeDeps({
      settlement: approved({
        status: 'TRANSFERRED',
        providerTransferId: 'tr_1',
        transferredMinor: 90000,
        releasedMinor: 90000,
      }),
      reverseTransfer,
    });

    await service.applyRefund('e1', 'usd', 30000);

    expect(attempts.some((a) => a.status === 'UNKNOWN')).toBe(true);
    expect(updated.some((d) => JSON.stringify(d).includes('decrement'))).toBe(false);
  });

  it('records an accepted-but-unproven reversal as PROCESSING, moving no money', async () => {
    // Razorpay cannot prove completion synchronously - its reversal entity has no status field.
    const reverseTransfer = jest
      .fn()
      .mockResolvedValue({ kind: 'ACCEPTED', reversalId: 'rvrsl_1', raw: {} });
    const { service, updated, attempts } = makeDeps({
      settlement: approved({
        status: 'TRANSFERRED',
        providerTransferId: 'tr_1',
        transferredMinor: 90000,
        releasedMinor: 90000,
      }),
      reverseTransfer,
    });

    await service.applyRefund('e1', 'usd', 30000);

    expect(
      attempts.some((a) => a.status === 'PROCESSING' && a.providerReversalId === 'rvrsl_1'),
    ).toBe(true);
    expect(updated.some((d) => JSON.stringify(d).includes('decrement'))).toBe(false);
  });

  it('does not decrement twice when the attempt was already settled', async () => {
    // The money move is guarded on the attempt still being REQUESTED.
    const reverseTransfer = jest.fn().mockResolvedValue({
      kind: 'CONFIRMED',
      reversalId: 'trr_4',
      confirmedMinor: 30000,
      raw: {},
    });
    const { service, updated } = makeDeps({
      settlement: approved({
        status: 'TRANSFERRED',
        providerTransferId: 'tr_1',
        transferredMinor: 90000,
        releasedMinor: 90000,
      }),
      attemptClaimCount: 0,
      reverseTransfer,
    });

    await service.applyRefund('e1', 'usd', 30000);

    expect(updated.some((d) => JSON.stringify(d).includes('decrement'))).toBe(false);
  });
});

/*
  Gross was rebuilt from SUCCEEDED payments only. A refunded payment dropped out of gross while
  its refund was still in `refundsMinor`, so release deducted the same refund twice.
*/
describe('SettlementService.syncForEvent', () => {
  it('keeps refunded and partly refunded payments in gross; refunds stay in refundsMinor', async () => {
    const { service, prisma } = makeDeps({ settlement: null });
    const payments = [
      { id: 'p1', status: 'SUCCEEDED', organizerNetMinor: 10_000, platformFeeMinor: 500 },
      { id: 'p2', status: 'REFUNDED', organizerNetMinor: 8_000, platformFeeMinor: 400 },
      { id: 'p3', status: 'PARTIALLY_REFUNDED', organizerNetMinor: 6_000, platformFeeMinor: 300 },
      { id: 'p4', status: 'FAILED', organizerNetMinor: 9_999, platformFeeMinor: 999 },
    ].map((p) => ({ ...p, currency: 'INR', provider: 'razorpay' }));
    const matches = (status: string, where: string | { in: string[] }) =>
      typeof where === 'string' ? status === where : where.in.includes(status);
    const upsert = jest.fn(async ({ create }: { create: Record<string, unknown> }) => ({
      id: 's1',
      ...create,
    }));
    Object.assign(prisma, {
      event: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'e1', organizationId: 'org1', status: 'LIVE' }),
      },
      payment: {
        findMany: jest.fn(async ({ where }: { where: { status: string | { in: string[] } } }) =>
          payments.filter((p) => matches(p.status, where.status)),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      organizerPaymentAccount: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    Object.assign(prisma.settlement, { upsert });

    await service.syncForEvent('e1');

    expect(upsert.mock.calls[0][0].create).toMatchObject({
      grossSalesMinor: 24_000,
      platformFeesMinor: 1_200,
    });
  });
});

describe('SettlementService.applyDispute', () => {
  it('deducts a lost dispute once — as a dispute, not also as a refund', async () => {
    const reverseTransfer = jest
      .fn()
      .mockResolvedValue({ reversalId: 'trr_1', status: 'COMPLETED' });
    const { service, prisma } = makeDeps({
      settlement: approved({
        status: 'TRANSFERRED',
        providerTransferId: 'tr_1',
        transferredMinor: 90_000,
      }),
      reverseTransfer,
    });

    await service.applyDispute('e1', 'usd', { amountMinor: 30_000, open: false, lost: true });

    const writes = prisma.settlement.update.mock.calls.map(([arg]) => arg.data);
    expect(writes).toContainEqual({ disputesMinor: { increment: 30_000 } });
    expect(writes.some((d) => 'refundsMinor' in d)).toBe(false);
    // The money already with the organizer still comes back, exactly once.
    expect(reverseTransfer).toHaveBeenCalledTimes(1);
    expect(reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: 'tr_1', amountMinor: 30_000 }),
    );
  });

  it('records nothing for a dispute delivery that is not the first loss', async () => {
    const { service, prisma } = makeDeps({ settlement: approved() });
    await service.applyDispute('e1', 'usd', { amountMinor: 30_000, open: false, lost: false });
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });
});
