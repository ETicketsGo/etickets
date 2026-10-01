import {
  reconcileAttempt,
  isStale,
  maySupersede,
  type ReconcilableAttempt,
} from './reversal-reconciliation';
import type { TransferReversalState } from '../provider/payment-provider.interface';

const attempt = (over: Partial<ReconcilableAttempt> = {}): ReconcilableAttempt => ({
  id: 'att_1',
  status: 'UNKNOWN',
  requestedMinor: 30_000,
  confirmedMinor: 0,
  otherConfirmedMinor: 0,
  ...over,
});

const providerSays = (
  amountReversedMinor: number,
  fullyReversed = false,
): TransferReversalState => ({
  transferId: 'tr_1',
  amountReversedMinor,
  fullyReversed,
  providerStatusRaw: null,
});

/**
 * The rule under test: reconciliation may SUPPLY missing evidence and may never OVERTURN settled
 * evidence. Everything below is a consequence of that one sentence.
 */
describe('resolving an attempt whose outcome we never learned', () => {
  it.each(['UNKNOWN', 'REQUESTED', 'PROCESSING'] as const)(
    'confirms a %s attempt the provider says was reversed',
    (status) => {
      const action = reconcileAttempt(attempt({ status }), providerSays(30_000));
      expect(action).toMatchObject({ kind: 'CONFIRM', confirmedMinor: 30_000 });
    },
  );

  it.each(['UNKNOWN', 'REQUESTED', 'PROCESSING'] as const)(
    'marks a %s attempt failed when the provider reversed nothing',
    (status) => {
      expect(reconcileAttempt(attempt({ status }), providerSays(0)).kind).toBe('MARK_FAILED');
    },
  );

  it('subtracts what other attempts already explain', () => {
    /*
      `amountReversedMinor` is cumulative across the whole transfer. A second attempt must only
      claim the part no earlier attempt accounts for, or the same money is confirmed twice.
    */
    const action = reconcileAttempt(
      attempt({ requestedMinor: 20_000, otherConfirmedMinor: 30_000 }),
      providerSays(50_000),
    );
    expect(action).toMatchObject({ kind: 'CONFIRM', confirmedMinor: 20_000 });
  });

  it('does not confirm a second attempt from the first attempt’s money', () => {
    // 30000 reversed, all of it already explained by an earlier completed attempt.
    const action = reconcileAttempt(
      attempt({ requestedMinor: 20_000, otherConfirmedMinor: 30_000 }),
      providerSays(30_000),
    );
    expect(action.kind).toBe('MARK_FAILED');
  });

  it('refuses to split a partial it cannot attribute', () => {
    /*
      The provider reversed less than we asked for. Confirming the partial amount invents an
      attribution; confirming the full amount overstates. Neither is ours to choose.
    */
    const action = reconcileAttempt(attempt({ requestedMinor: 30_000 }), providerSays(12_000));
    expect(action.kind).toBe('OPERATOR_REVIEW');
    expect((action as { reason: string }).reason).toContain('12000');
  });
});

describe('settled evidence is never overturned', () => {
  it('agrees when the provider confirms what we already recorded', () => {
    const action = reconcileAttempt(
      attempt({ status: 'COMPLETED', confirmedMinor: 30_000 }),
      providerSays(30_000),
    );
    expect(action.kind).toBe('AGREES');
  });

  it('raises an operator case when the provider reports LESS than we completed', () => {
    /*
      We say money came back; the provider says less did. That is a disagreement about a settled
      financial fact, and code flipping it on one read is exactly the failure this whole design
      exists to prevent.
    */
    const action = reconcileAttempt(
      attempt({ status: 'COMPLETED', confirmedMinor: 30_000 }),
      providerSays(10_000),
    );
    expect(action.kind).toBe('OPERATOR_REVIEW');
  });

  it('never silently turns COMPLETED into FAILED', () => {
    const kinds = [0, 5_000, 29_999].map(
      (reversed) =>
        reconcileAttempt(
          attempt({ status: 'COMPLETED', confirmedMinor: 30_000 }),
          providerSays(reversed),
        ).kind,
    );
    expect(kinds).not.toContain('MARK_FAILED');
    expect(new Set(kinds)).toEqual(new Set(['OPERATOR_REVIEW']));
  });

  it('raises an operator case when a FAILED attempt looks like it happened', () => {
    // We called it a refusal and the provider reversed money. Somebody must look.
    const action = reconcileAttempt(attempt({ status: 'FAILED' }), providerSays(30_000));
    expect(action.kind).toBe('OPERATOR_REVIEW');
  });

  it('agrees when a FAILED attempt really did nothing', () => {
    expect(reconcileAttempt(attempt({ status: 'FAILED' }), providerSays(0)).kind).toBe('AGREES');
  });

  it('never confirms an already-terminal attempt', () => {
    for (const status of ['COMPLETED', 'FAILED'] as const) {
      for (const reversed of [0, 15_000, 30_000, 90_000]) {
        expect(
          reconcileAttempt(
            attempt({ status, confirmedMinor: status === 'COMPLETED' ? 30_000 : 0 }),
            providerSays(reversed),
          ).kind,
        ).not.toBe('CONFIRM');
      }
    }
  });
});

describe('what may be asked about, and what may be retried', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const windows = { requestedMs: 60_000, processingMs: 600_000 };

  it('asks about a REQUESTED attempt only once it is overdue', () => {
    expect(isStale('REQUESTED', ago(30_000), now, windows)).toBe(false);
    expect(isStale('REQUESTED', ago(90_000), now, windows)).toBe(true);
  });

  it('gives PROCESSING longer, because the provider said it had it', () => {
    expect(isStale('PROCESSING', ago(90_000), now, windows)).toBe(false);
    expect(isStale('PROCESSING', ago(700_000), now, windows)).toBe(true);
  });

  it('always asks about UNKNOWN, which has no expected completion time', () => {
    expect(isStale('UNKNOWN', ago(1), now, windows)).toBe(true);
  });

  it('never asks about a terminal attempt', () => {
    expect(isStale('COMPLETED', ago(999_999), now, windows)).toBe(false);
    expect(isStale('FAILED', ago(999_999), now, windows)).toBe(false);
  });

  it('allows a retry ONLY after an authoritative failure', () => {
    /*
      The sharp edge. A stale REQUESTED attempt is not retryable: the crash may have happened
      while the call was in flight, so the provider may already have acted, and reissuing would
      claw the money back twice. "Old" is not "safe to repeat".
    */
    expect(maySupersede('FAILED')).toBe(true);
    expect(maySupersede('REQUESTED')).toBe(false);
    expect(maySupersede('PROCESSING')).toBe(false);
    expect(maySupersede('UNKNOWN')).toBe(false);
    expect(maySupersede('COMPLETED')).toBe(false);
  });
});
