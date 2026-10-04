import { describe, it, expect } from 'vitest';
import {
  REVERSAL_TRANSITIONS,
  canTransitionReversal,
  isTerminalReversal,
  canSupersede,
  movedMinor,
  confirmedTotalMinor,
  outstandingTransferredMinor,
  reversalViolations,
  reversibleMinor,
  type SettlementReversalStatus,
  type ReversalAmountView,
} from './settlement-reversal';

const ALL: SettlementReversalStatus[] = [
  'REQUESTED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'UNKNOWN',
];

const at = (
  status: SettlementReversalStatus,
  requestedMinor: number,
  confirmedMinor = status === 'COMPLETED' ? requestedMinor : 0,
): ReversalAmountView => ({ status, requestedMinor, confirmedMinor });

describe('every transition pair is decided, not left to chance', () => {
  it.each(ALL.flatMap((from) => ALL.map((to) => [from, to] as const)))(
    '%s -> %s is explicitly allowed or refused',
    (from, to) => {
      const allowed = canTransitionReversal(from, to);
      expect(typeof allowed).toBe('boolean');
      expect(allowed).toBe(REVERSAL_TRANSITIONS[from].includes(to));
    },
  );

  it('refuses a status it has never heard of', () => {
    expect(canTransitionReversal('NOT_A_STATUS' as SettlementReversalStatus, 'COMPLETED')).toBe(
      false,
    );
  });
});

describe('UNKNOWN', () => {
  it('is not terminal', () => {
    /*
      The whole reason it exists. A timeout is not a failure: the provider may have moved money
      while our response was lost. Making it terminal would turn "we do not know" into a settled
      financial fact.
    */
    expect(isTerminalReversal('UNKNOWN')).toBe(false);
  });

  it('can still be resolved either way by later evidence', () => {
    expect(canTransitionReversal('UNKNOWN', 'COMPLETED')).toBe(true);
    expect(canTransitionReversal('UNKNOWN', 'FAILED')).toBe(true);
  });

  it('moves no money by itself, however much it asked for', () => {
    expect(movedMinor(at('UNKNOWN', 50_000, 0))).toBe(0);
    // Even a row that wrongly carries a confirmed amount contributes nothing while UNKNOWN.
    expect(movedMinor({ status: 'UNKNOWN', requestedMinor: 50_000, confirmedMinor: 50_000 })).toBe(
      0,
    );
  });

  it('leaves the outstanding amount untouched', () => {
    const outstanding = outstandingTransferredMinor(100_000, [at('UNKNOWN', 40_000, 0)]);
    expect(outstanding).toBe(100_000);
  });
});

describe('terminal states cannot be rewritten', () => {
  it('COMPLETED cannot silently become FAILED', () => {
    expect(canTransitionReversal('COMPLETED', 'FAILED')).toBe(false);
    expect(isTerminalReversal('COMPLETED')).toBe(true);
  });

  it('FAILED cannot become COMPLETED on the same attempt', () => {
    /*
      A provider later saying it did happen is evidence, not a transition. It becomes a mismatch
      for a person, and the recovery is a NEW attempt - so the original argument stays readable.
    */
    expect(canTransitionReversal('FAILED', 'COMPLETED')).toBe(false);
    expect(isTerminalReversal('FAILED')).toBe(true);
  });

  it('lets a FAILED or UNKNOWN attempt be superseded, but not a COMPLETED one', () => {
    expect(canSupersede('FAILED')).toBe(true);
    expect(canSupersede('UNKNOWN')).toBe(true);
    expect(canSupersede('REQUESTED')).toBe(true);
    expect(canSupersede('COMPLETED')).toBe(false);
  });
});

describe('only COMPLETED moves money', () => {
  it.each(['REQUESTED', 'PROCESSING', 'FAILED', 'UNKNOWN'] as SettlementReversalStatus[])(
    '%s contributes nothing',
    (status) => {
      expect(movedMinor(at(status, 30_000, 0))).toBe(0);
    },
  );

  it('COMPLETED contributes exactly what the provider confirmed', () => {
    // Not what was requested - the provider may confirm less.
    expect(
      movedMinor({ status: 'COMPLETED', requestedMinor: 30_000, confirmedMinor: 25_000 }),
    ).toBe(25_000);
  });

  it('refuses an attempt carrying money it has not proven', () => {
    expect(
      reversalViolations({ status: 'PROCESSING', requestedMinor: 10_000, confirmedMinor: 10_000 }),
    ).toContain('confirmedMinor must be 0 while PROCESSING');
  });

  it('refuses a confirmation larger than the request', () => {
    expect(
      reversalViolations({ status: 'COMPLETED', requestedMinor: 10_000, confirmedMinor: 11_000 }),
    ).toContain('confirmedMinor cannot exceed requestedMinor');
  });

  it('accepts an honest attempt', () => {
    expect(reversalViolations(at('COMPLETED', 10_000))).toEqual([]);
    expect(reversalViolations(at('REQUESTED', 10_000))).toEqual([]);
  });
});

describe('confirmed reversals cannot exceed what was released', () => {
  it('clamps a request to what the organizer still holds', () => {
    expect(reversibleMinor(80_000, 100_000, [at('COMPLETED', 70_000)])).toBe(30_000);
  });

  it('returns zero once everything is back', () => {
    expect(reversibleMinor(10_000, 100_000, [at('COMPLETED', 100_000)])).toBe(0);
  });

  it('ignores unconfirmed attempts when deciding what remains', () => {
    // A PROCESSING attempt has not taken anything back yet, so it does not reduce the headroom.
    expect(reversibleMinor(100_000, 100_000, [at('PROCESSING', 90_000)])).toBe(100_000);
  });

  it('never returns a negative amount', () => {
    expect(reversibleMinor(50_000, 0, [])).toBe(0);
  });
});

describe('over generated histories', () => {
  /** Deterministic, so a failure is reproducible rather than a lucky seed. */
  const rand = (seed: number) => {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  };

  it('holds every invariant across 500 random histories', () => {
    const next = rand(20261001);

    for (let run = 0; run < 500; run += 1) {
      const released = 1_000 + Math.floor(next() * 500_000);
      const attempts: ReversalAmountView[] = [];
      let confirmedSoFar = 0;

      const count = Math.floor(next() * 5);
      for (let i = 0; i < count; i += 1) {
        const headroom = released - confirmedSoFar;
        const wanted = 1 + Math.floor(next() * Math.max(1, headroom));
        const allowed = reversibleMinor(wanted, released, attempts);
        if (allowed <= 0) break;

        const status = (['COMPLETED', 'PROCESSING', 'FAILED', 'UNKNOWN'] as const)[
          Math.floor(next() * 4)
        ];
        const a = at(status, allowed);
        attempts.push(a);
        confirmedSoFar += movedMinor(a);
      }

      // I1: confirmed never exceeds what was released.
      expect(confirmedTotalMinor(attempts)).toBeLessThanOrEqual(released);
      // I2: outstanding is the derivation, and never negative.
      const outstanding = outstandingTransferredMinor(released, attempts);
      expect(outstanding).toBe(released - confirmedTotalMinor(attempts));
      expect(outstanding).toBeGreaterThanOrEqual(0);
      // I3: no attempt carries money it has not proven.
      for (const a of attempts) expect(reversalViolations(a)).toEqual([]);
    }
  });
});
