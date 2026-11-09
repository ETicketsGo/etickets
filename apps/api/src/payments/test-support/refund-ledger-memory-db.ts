import { SettlementService } from '../settlement/settlement.service';

/*
  A small in-memory stand-in for the two rows a refund webhook writes: the Payment (its
  `refundedMinor`) and the event's Settlement (its `refundsMinor`). It exists for AR-54, whose
  tests need three things a plain jest mock cannot give:

    - `$transaction` that really rolls back: every write inside it is undone if the callback
      throws, so a test can prove the payment change does not survive a failed debit;
    - `payment.updateMany` that evaluates its WHERE against the committed row at the moment it
      runs, the way Postgres re-checks an UPDATE's predicate under READ COMMITTED, so a
      compare-and-set on `refundedMinor` behaves as it does in production;
    - a read gate, so two deliveries can be made to read the payment before either writes:
      the interleaving that used to debit a settlement twice.

  It is used with the REAL SettlementService, so the ledger write under test is the production
  one, not a double of it.
*/

export interface MemoryPayment {
  id: string;
  bookingId: string;
  amountMinor: number;
  organizerNetMinor: number;
  refundedMinor: number;
  currency: string;
  status: string;
  booking: { eventId: string };
}

export interface MemorySettlement {
  id: string;
  eventId: string;
  currency: string;
  provider: string;
  status: string;
  providerTransferId: string | null;
  refundsMinor: number;
}

type Undo = () => void;

export function refundLedgerMemoryDb(init: {
  payment: MemoryPayment;
  settlement: MemorySettlement;
}) {
  const state = {
    payment: structuredClone(init.payment),
    settlement: structuredClone(init.settlement),
  };
  /** Number of settlement updates that will throw before any succeeds. */
  let failSettlementUpdates = 0;
  let settlementUpdateCalls = 0;
  /** Held payment reads: each waits until `gateSize` reads have arrived, then all proceed. */
  let gateSize = 0;
  let gateWaiting: Array<() => void> = [];

  const client = (undo: Undo[] | null) => ({
    payment: {
      findFirst: async () => {
        const snapshot = structuredClone(state.payment);
        if (gateSize > 0) {
          await new Promise<void>((resolve) => {
            gateWaiting.push(resolve);
            if (gateWaiting.length >= gateSize) {
              gateSize = 0;
              const release = gateWaiting;
              gateWaiting = [];
              release.forEach((r) => r());
            }
          });
        }
        return snapshot;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; refundedMinor?: number };
        data: Partial<MemoryPayment>;
      }) => {
        const row = state.payment;
        if (row.id !== where.id) return { count: 0 };
        if (where.refundedMinor !== undefined && row.refundedMinor !== where.refundedMinor) {
          return { count: 0 };
        }
        const before = { refundedMinor: row.refundedMinor, status: row.status };
        Object.assign(row, data);
        undo?.push(() => Object.assign(row, before));
        return { count: 1 };
      },
    },
    settlement: {
      findUnique: async ({
        where,
      }: {
        where: { eventId_currency: { eventId: string; currency: string } };
      }) => {
        const s = state.settlement;
        const key = where.eventId_currency;
        return s.eventId === key.eventId && s.currency === key.currency ? structuredClone(s) : null;
      },
      update: async ({ data }: { data: { refundsMinor: { increment: number } } }) => {
        settlementUpdateCalls += 1;
        if (failSettlementUpdates > 0) {
          failSettlementUpdates -= 1;
          throw new Error('settlement write failed');
        }
        const amount = data.refundsMinor.increment;
        state.settlement.refundsMinor += amount;
        undo?.push(() => {
          state.settlement.refundsMinor -= amount;
        });
        return structuredClone(state.settlement);
      },
    },
  });

  const prisma = {
    ...client(null),
    $transaction: async <T>(fn: (tx: ReturnType<typeof client>) => Promise<T>): Promise<T> => {
      const undo: Undo[] = [];
      try {
        return await fn(client(undo));
      } catch (err) {
        undo.reverse().forEach((u) => u());
        throw err;
      }
    },
  };

  const noop = async () => undefined;
  const settlements = new SettlementService(
    prisma as never,
    { record: noop } as never,
    { send: noop, sendCritical: noop } as never,
    { get: () => undefined } as never,
    // A settlement that was never transferred has nothing to reverse: an adapter with no
    // `reverseTransfer` makes the reversal step return before any provider call.
    { get: () => ({}) } as never,
  );

  return {
    prisma,
    settlements,
    state,
    /** The next `n` settlement debits throw, inside whatever transaction they run in. */
    failNextSettlementUpdates(n: number) {
      failSettlementUpdates = n;
    },
    settlementUpdateCalls: () => settlementUpdateCalls,
    /** Hold the next `n` payment reads until all `n` have happened. */
    raceNextPaymentReads(n: number) {
      gateSize = n;
    },
  };
}
