import { TransferObservationWorker } from './transfer-observation.worker';
import type { TransferState } from '../provider/payment-provider.interface';

/**
 * unit — the observation worker observes, and cannot do anything else.
 *
 * Two properties matter more than any individual behaviour here: it is OFF unless explicitly
 * enabled, and it is structurally incapable of moving money. Both are asserted directly.
 */

const attempt = (over: Record<string, unknown> = {}) => ({
  id: 'att_1',
  settlementId: 's_1',
  status: 'UNKNOWN',
  requestedMinor: 50_000,
  currency: 'inr',
  provider: 'razorpay',
  providerTransferId: null,
  idempotencyKey: 'settlement_s_1_0',
  destinationAccountId: 'acc_1',
  requestedAt: new Date(),
  settlement: { organizationId: 'org_1' },
  ...over,
});

function makeWorker(opts: {
  enabled?: boolean;
  attempts?: Array<Record<string, unknown>>;
  reader?: unknown;
  outcome?: { kind: string };
}) {
  const reconcileOne = jest.fn(
    async (_local: unknown, _reader: unknown) =>
      opts.outcome ?? { kind: 'FINDING', finding: 'CANNOT_BE_ASKED', state: null },
  );
  const reconciliation = {
    unresolvedAttempts: jest.fn(async () => opts.attempts ?? []),
    reconcileOne,
  };
  const config = {
    get: (k: string) =>
      k === 'TRANSFER_OBSERVATION_ENABLED' ? (opts.enabled ?? false) : undefined,
  };
  const worker = new TransferObservationWorker(
    reconciliation as never,
    config as never,
    {
      for: () => (opts.reader as never) ?? null,
    } as never,
  );
  return { worker, reconciliation, reconcileOne };
}

describe('it is off', () => {
  it('does nothing at all unless explicitly enabled', async () => {
    const { worker, reconciliation } = makeWorker({ attempts: [attempt()] });
    const out = await worker.sweep();
    expect(out.enabled).toBe(false);
    expect(out.examined).toBe(0);
    // Not even a read. Disabled means disabled.
    expect(reconciliation.unresolvedAttempts).not.toHaveBeenCalled();
  });

  it('is off for anything other than an explicit true', async () => {
    for (const v of [undefined, false, 'false', '1', 'yes', 'TRUE']) {
      const { worker } = makeWorker({ enabled: v as never, attempts: [attempt()] });
      expect((await worker.sweep()).enabled).toBe(false);
    }
  });

  it('runs when explicitly enabled, by boolean or by string', async () => {
    for (const v of [true, 'true']) {
      const { worker } = makeWorker({ enabled: v as never, attempts: [attempt()] });
      expect((await worker.sweep()).enabled).toBe(true);
    }
  });
});

describe('it cannot move money, by construction', () => {
  it('is given a reader with exactly one method, which reads', async () => {
    /*
      THE PROPERTY THAT MATTERS. Not "the worker does not call createTransfer" - it has nothing
      to call it on. The only provider-shaped object it ever sees is this one.
    */
    const reader = { getTransferState: jest.fn(async (): Promise<TransferState> => state()) };
    const { worker } = makeWorker({ enabled: true, attempts: [attempt()], reader });
    await worker.sweep();
    expect(Object.keys(reader)).toEqual(['getTransferState']);
  });

  it('never reaches for a money-moving method, because none is in scope', async () => {
    /*
      A reader that would scream if the worker tried. If the worker ever gained a money-moving
      dependency, this double would not be what it was handed - which is the point: the type is
      the guard, and this is the demonstration.
    */
    const forbidden = ['createTransfer', 'reverseTransfer', 'refund', 'cancel'] as const;
    const reader: Record<string, unknown> = {
      getTransferState: jest.fn(async (): Promise<TransferState> => state()),
    };
    for (const name of forbidden) {
      Object.defineProperty(reader, name, {
        get() {
          throw new Error(`the observation worker reached for ${name}`);
        },
      });
    }
    const { worker } = makeWorker({ enabled: true, attempts: [attempt()], reader });
    await expect(worker.sweep()).resolves.toMatchObject({ enabled: true });
  });
});

describe('what a pass does', () => {
  it('records that a provider could not be asked, rather than retrying it', async () => {
    // No adapter implements a status query today, so this is every attempt.
    const { worker, reconcileOne } = makeWorker({ enabled: true, attempts: [attempt()] });
    const out = await worker.sweep();
    expect(out).toMatchObject({ examined: 1, asked: 0, couldNotAsk: 1, findings: 1 });
    // It still went through reconciliation, so the inability is RECORDED rather than skipped.
    expect(reconcileOne).toHaveBeenCalledTimes(1);
    expect(reconcileOne.mock.calls[0][1]).toBeNull();
  });

  it('counts what it asked and what it learned', async () => {
    const reader = { getTransferState: jest.fn(async (): Promise<TransferState> => state()) };
    const { worker } = makeWorker({
      enabled: true,
      attempts: [attempt(), attempt({ id: 'att_2' })],
      reader,
      outcome: { kind: 'RESOLVED' },
    });
    const out = await worker.sweep();
    expect(out).toMatchObject({ examined: 2, asked: 2, couldNotAsk: 0, resolved: 2, findings: 0 });
  });

  it('bounds a pass, so it cannot grow with the backlog', async () => {
    const { worker, reconciliation } = makeWorker({ enabled: true, attempts: [] });
    await worker.sweep(7);
    expect(reconciliation.unresolvedAttempts).toHaveBeenCalledWith(7);
  });

  it('passes the identity we hold, not one we wish we had', async () => {
    const reader = { getTransferState: jest.fn(async (): Promise<TransferState> => state()) };
    const { worker, reconcileOne } = makeWorker({
      enabled: true,
      attempts: [attempt({ providerTransferId: null })],
      reader,
    });
    await worker.sweep();
    expect(reconcileOne.mock.calls[0][0]).toMatchObject({
      idempotencyKey: 'settlement_s_1_0',
      providerTransferId: null,
    });
  });
});

function state(): TransferState {
  return {
    transferId: 'trf_1',
    disposition: 'SENT',
    amountMinor: 50_000,
    currency: 'inr',
    providerStatusRaw: 'processed',
  };
}
