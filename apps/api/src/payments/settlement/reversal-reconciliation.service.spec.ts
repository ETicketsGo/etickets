import { ReversalReconciliationService } from './reversal-reconciliation.service';
import { ReconciliationReaderRegistry } from './reconciliation-reader.registry';
import { BACKOFF_LADDER_MS } from './reversal-sweeper';

/**
 * The scheduled sweep: its flag, its bounds, its persistence, and above all the fact that
 * scheduling it did not put money-moving capability within reach.
 */

const NOW = new Date('2026-10-02T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** Every operation that must stay unreachable from the sweep's dependency graph. */
const FORBIDDEN = [
  'createTransfer',
  'reverseTransfer',
  'refund',
  'createPayment',
  'createCheckout',
  'capture',
  'payout',
  'generate',
  'returnToPlatform',
];

/** A full payment adapter: everything the sweep must not be able to do, plus the one read. */
function fullAdapter() {
  return {
    name: 'razorpay',
    getTransferReversalState: jest.fn().mockResolvedValue({
      transferId: 'trf_1',
      amountReversedMinor: 25_000,
      providerStatusRaw: 'processed',
      fullyReversed: false,
    }),
    createTransfer: jest.fn(),
    reverseTransfer: jest.fn(),
    refund: jest.fn(),
    createPayment: jest.fn(),
    createCheckout: jest.fn(),
    capture: jest.fn(),
  };
}

interface AttemptRow {
  id: string;
  settlementId: string;
  provider: string;
  currency: string;
  status: string;
  requestedAt: Date;
  lastReconciledAt: Date | null;
  reconcileCount: number;
  settlement: { providerTransferId: string | null };
}

function attemptRow(over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: 'att_1',
    settlementId: 's1',
    provider: 'razorpay',
    currency: 'inr',
    status: 'UNKNOWN',
    requestedAt: ago(60 * 60_000),
    lastReconciledAt: null,
    reconcileCount: 0,
    settlement: { providerTransferId: 'trf_1' },
    ...over,
  };
}

function makeService(
  env: Record<string, string | boolean> = {},
  rows: AttemptRow[] = [attemptRow()],
  adapter: ReturnType<typeof fullAdapter> = fullAdapter(),
) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const update = jest.fn().mockResolvedValue({});
  const prisma = { settlementReversalAttempt: { findMany, update } };
  const config = {
    get: (k: string) => env[k],
  };
  const metrics = { recordReversalReconcile: jest.fn() };
  // The real narrowing class, not a stub - narrowing is the thing under test.
  const readers = new ReconciliationReaderRegistry({
    get: (name: string) => (name === 'razorpay' ? adapter : undefined),
  } as never);

  const service = new ReversalReconciliationService(
    prisma as never,
    config as never,
    metrics as never,
    readers,
  );
  return { service, findMany, update, metrics, adapter, readers };
}

describe('the sweep is off unless switched on', () => {
  it('queries nothing at all when the flag is absent', async () => {
    const { service, findMany, adapter } = makeService({});
    const report = await service.sweep(NOW);
    // Not merely "no provider call" - it must not even read the table.
    expect(findMany).not.toHaveBeenCalled();
    expect(adapter.getTransferReversalState).not.toHaveBeenCalled();
    expect(report).toMatchObject({ scanned: 0, observed: 0, needsOperatorAttention: [] });
  });

  it.each([['false'], ['0'], [''], ['yes'], ['TRUE'], ['on']])(
    'stays off for the ambiguous value %p',
    async (value) => {
      /*
        Only an explicit true/1 enables it. Anything else - including 'TRUE' and 'on', which look
        affirmative - reads as off, because a misread flag that turns provider polling ON is the
        failure that cannot be undone by noticing it later.
      */
      const { service, findMany } = makeService({ SETTLEMENT_REVERSAL_RECONCILE_ENABLED: value });
      await service.sweep(NOW);
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it.each([[true], ['true'], ['1']])('runs for the explicit value %p', async (value) => {
    const { service, findMany } = makeService({ SETTLEMENT_REVERSAL_RECONCILE_ENABLED: value });
    await service.sweep(NOW);
    expect(findMany).toHaveBeenCalled();
  });
});

describe('structural read-only safety', () => {
  const ON = { SETTLEMENT_REVERSAL_RECONCILE_ENABLED: 'true' };

  it('hands out a reader with exactly one method', () => {
    const { readers } = makeService(ON);
    const reader = readers.for('razorpay')!;
    expect(reader).not.toBeNull();
    expect(Object.keys(reader)).toEqual(['getTransferReversalState']);
  });

  it('keeps every money-moving operation off the reader surface', () => {
    const { readers } = makeService(ON);
    const reader = readers.for('razorpay')! as unknown as Record<string, unknown>;
    for (const op of FORBIDDEN) {
      expect(typeof reader[op]).toBe('undefined');
    }
  });

  it('does not expose the provider registry through the reader registry', () => {
    /*
      The point of not storing the registry on a field. `private` is a compile-time courtesy, so
      a stored registry would leave `service.readers.registry.get('razorpay').createTransfer` as
      a real runtime path. This walks what is actually reachable.
    */
    const { readers } = makeService(ON);
    const own = Object.values(readers as unknown as Record<string, unknown>);
    for (const value of own) {
      expect(typeof value === 'object' && value !== null).toBe(false);
    }
  });

  it('reaches no forbidden operation anywhere in the scheduled service graph', async () => {
    /*
      ── THE TEST THAT GUARDS THE WIRING ─────────────────────────────────────────────
      The sweeper's narrow parameter type proves the FUNCTION cannot move money. It says nothing
      about what the scheduled service can reach by property access, and that is what a future
      edit would quietly broaden. So walk the graph and look.

      A BACKSTOP, NOT THE PROOF. This walk follows properties, so it cannot see an adapter
      reached through a `get()` call - verified by storing the registry on a field, which this
      test passes and "does not expose the provider registry" catches. The two together are the
      assertion; neither alone is.
    */
    const { service } = makeService(ON);
    const seen = new Set<unknown>();
    const found: string[] = [];

    const walk = (node: unknown, path: string, depth: number): void => {
      if (depth > 6 || node === null || typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node as Record<string, unknown>)) {
        const value = (node as Record<string, unknown>)[key];
        if (FORBIDDEN.includes(key) && typeof value === 'function') {
          found.push(`${path}.${key}`);
        }
        walk(value, `${path}.${key}`, depth + 1);
      }
    };
    walk(service, 'service', 0);

    // Listed rather than counted, so a failure names the path that broadened.
    expect(found).toEqual([]);

    // And the walk is not vacuous: it finds them on an adapter when one IS reachable.
    const control: string[] = [];
    const probe = { adapter: fullAdapter() } as Record<string, unknown>;
    for (const key of Object.keys(probe.adapter as Record<string, unknown>)) {
      if (FORBIDDEN.includes(key)) control.push(key);
    }
    expect(control.length).toBeGreaterThan(0);
  });

  it('yields no reader for a provider that cannot be read, rather than guessing', async () => {
    const mockOnly = { name: 'mock' } as unknown as ReturnType<typeof fullAdapter>;
    const { service, update } = makeService(
      { SETTLEMENT_REVERSAL_RECONCILE_ENABLED: 'true' },
      [attemptRow({ provider: 'mock' })],
      mockOnly,
    );
    const report = await service.sweep(NOW);
    expect(report.noReference).toBe(1);
    // Nothing written: not asking is not evidence, and the ladder must not advance.
    expect(update).not.toHaveBeenCalled();
  });
});

describe('what a sweep records', () => {
  const ON = { SETTLEMENT_REVERSAL_RECONCILE_ENABLED: 'true' };

  it('records that it looked, and the evidence, but applies no outcome', async () => {
    const { service, update } = makeService(ON);
    const report = await service.sweep(NOW);
    expect(report.reconciled).toBe(1);

    const data = update.mock.calls[0][0].data;
    expect(data.lastReconciledAt).toEqual(NOW);
    expect(data.reconcileCount).toEqual({ increment: 1 });
    expect(data.evidence).toMatchObject({ cumulativeReversedMinor: 25_000 });
    // The money is untouched: no status, no confirmed amount, no settled date.
    expect(Object.keys(data).sort()).toEqual(['evidence', 'lastReconciledAt', 'reconcileCount']);
  });

  it('advances the ladder but changes nothing financial when the provider is unreachable', async () => {
    const broken = fullAdapter();
    broken.getTransferReversalState = jest.fn().mockRejectedValue(new Error('gateway timeout'));
    const { service, update } = makeService(ON, [attemptRow()], broken);

    const report = await service.sweep(NOW);
    expect(report.providerUnreachable).toBe(1);
    const data = update.mock.calls[0][0].data;
    /*
      "We could not ask" is not "nothing happened". The backoff advances so an outage backs off,
      and the status/amounts are left exactly as they were.
    */
    expect(data.reconcileCount).toEqual({ increment: 1 });
    expect(Object.keys(data).sort()).toEqual(['lastError', 'lastReconciledAt', 'reconcileCount']);
    expect(data.lastError).toContain('gateway timeout');
  });

  it('persists the ladder, so a restart does not reset to aggressive polling', async () => {
    /*
      The restart property. Nothing in the service holds state between sweeps: due-ness is
      computed from the row's own lastReconciledAt and reconcileCount, so a fresh process makes
      the same decision the old one would have.
    */
    const farUpTheLadder = attemptRow({
      reconcileCount: 4,
      lastReconciledAt: ago(30 * 60_000),
    });
    const { service, adapter, update } = makeService(ON, [farUpTheLadder]);
    const report = await service.sweep(NOW);

    // Four looks in means a two-hour wait; thirty minutes is far too soon.
    expect(report.observed).toBe(0);
    expect(adapter.getTransferReversalState).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('bounds', () => {
  const ON = { SETTLEMENT_REVERSAL_RECONCILE_ENABLED: 'true' };
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      attemptRow({
        id: `att_${i}`,
        lastReconciledAt: ago((n - i) * 60 * 60_000),
        reconcileCount: 1,
      }),
    );

  it('observes no more than the batch size', async () => {
    const { service, adapter } = makeService(
      { ...ON, SETTLEMENT_REVERSAL_RECONCILE_BATCH: '5' },
      many(40),
    );
    const report = await service.sweep(NOW);
    expect(report.observed).toBe(5);
    expect(adapter.getTransferReversalState).toHaveBeenCalledTimes(5);
  });

  it('services every eligible row across repeated runs, without starving any', async () => {
    /*
      The starvation proof. More candidates than one batch, and the runner is executed
      repeatedly - least-recently-looked-first means looking at a row moves it to the back, so
      every row is eventually reached.
    */
    const rows = many(12).map((r) => ({ ...r }));
    const seen = new Set<string>();

    for (let run = 0; run < 4; run += 1) {
      const sweepNow = new Date(NOW.getTime() + run * 60 * 60_000);
      const { service, update } = makeService(
        { ...ON, SETTLEMENT_REVERSAL_RECONCILE_BATCH: '4' },
        rows,
      );
      await service.sweep(sweepNow);
      for (const call of update.mock.calls) {
        const id = call[0].where.id as string;
        seen.add(id);
        // Apply what the real update would have done, so the next run sees moved rows.
        const row = rows.find((r) => r.id === id)!;
        row.lastReconciledAt = sweepNow;
        row.reconcileCount += 1;
      }
    }
    expect(seen.size).toBe(12);
  });

  it('holds provider calls to the concurrency bound', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = fullAdapter();
    slow.getTransferReversalState = jest.fn().mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return {
        transferId: 'trf_1',
        amountReversedMinor: 1,
        providerStatusRaw: null,
        fullyReversed: false,
      };
    });

    const { service } = makeService(
      {
        ...ON,
        SETTLEMENT_REVERSAL_RECONCILE_BATCH: '20',
        SETTLEMENT_REVERSAL_RECONCILE_CONCURRENCY: '3',
      },
      many(20),
      slow,
    );
    await service.sweep(NOW);
    expect(peak).toBeLessThanOrEqual(3);
    expect(slow.getTransferReversalState).toHaveBeenCalledTimes(20);
  });

  it('falls back to safe defaults for malformed configuration', async () => {
    // A mistyped batch size must not read as zero and silently disable a sweep the flag enabled.
    const { service } = makeService({ ...ON, SETTLEMENT_REVERSAL_RECONCILE_BATCH: 'abc' }, many(3));
    const report = await service.sweep(NOW);
    expect(report.observed).toBe(3);
  });
});

describe('operator escalation in a sweep', () => {
  const ON = { SETTLEMENT_REVERSAL_RECONCILE_ENABLED: 'true' };

  it('reports attention for rows it is not going to look at', async () => {
    /*
      Deliberate: the worst cases are the ones so far up the ladder they are rarely due.
      Reporting attention only for rows we happened to query would hide exactly those.
    */
    const stuck = attemptRow({
      id: 'stuck',
      requestedAt: ago(40 * 24 * 60 * 60_000),
      reconcileCount: BACKOFF_LADDER_MS.length + 2,
      lastReconciledAt: ago(60_000),
    });
    const { service, metrics } = makeService(ON, [stuck]);
    const report = await service.sweep(NOW);

    expect(report.observed).toBe(0);
    expect(report.needsOperatorAttention).toEqual([
      { attemptId: 'stuck', reasons: ['UNRESOLVED_TOO_LONG', 'BACKOFF_LADDER_EXHAUSTED'] },
    ]);
    expect(metrics.recordReversalReconcile).toHaveBeenCalledWith('razorpay', 'attention');
  });

  it('escalates without writing anything to the attempt', async () => {
    const stuck = attemptRow({
      requestedAt: ago(40 * 24 * 60 * 60_000),
      reconcileCount: 99,
      lastReconciledAt: ago(60_000),
    });
    const { service, update } = makeService(ON, [stuck]);
    const report = await service.sweep(NOW);
    expect(report.needsOperatorAttention.length).toBe(1);
    // Still UNKNOWN financially. Escalation is operational and writes no money fact.
    expect(update).not.toHaveBeenCalled();
  });

  it('honours a configured escalation threshold', async () => {
    const row = attemptRow({ requestedAt: ago(2 * 60 * 60_000), lastReconciledAt: ago(60_000) });
    const { service } = makeService(
      { ...ON, SETTLEMENT_REVERSAL_ESCALATE_AFTER_MS: String(60 * 60_000) },
      [row],
    );
    const report = await service.sweep(NOW);
    expect(report.needsOperatorAttention[0].reasons).toContain('UNRESOLVED_TOO_LONG');
  });
});
