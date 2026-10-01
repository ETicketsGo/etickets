import { describe, it, expect } from 'vitest';
import { onePathViolations, holdsOnePath } from './finance-one-path';
import type { FinanceEntry, FinanceSourceType } from './finance-entry';

const entry = (over: Partial<FinanceEntry> & { sourceType: FinanceSourceType }): FinanceEntry => ({
  sourceId: `${over.sourceType}-${Math.random().toString(36).slice(2, 8)}`,
  sourceStatus: over.sourceType === 'PAYOUT' ? 'PAID' : 'TRANSFERRED',
  state: 'PAID',
  organizationId: 'org1',
  currency: 'INR',
  eventId: 'e1',
  periodStart: null,
  periodEnd: null,
  money: { organizerNetMinor: 10_000 },
  ...over,
});

describe('the one-path invariant', () => {
  it('holds when each event is claimed by one path only', () => {
    const entries = [
      entry({ sourceType: 'PAYOUT', eventId: 'e1' }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e2' }),
      entry({ sourceType: 'PAYOUT', eventId: 'e3' }),
    ];
    expect(holdsOnePath(entries)).toBe(true);
    expect(onePathViolations(entries)).toEqual([]);
  });

  it('catches the same event claimed by both paths', () => {
    /*
      The failure this exists for. It does not crash anything: the organizer is simply shown the
      same revenue twice, and the total looks plausible.
    */
    const entries = [
      entry({ sourceType: 'PAYOUT', eventId: 'e1' }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1' }),
    ];
    const violations = onePathViolations(entries);

    expect(holdsOnePath(entries)).toBe(false);
    expect(violations).toHaveLength(1);
    expect(violations[0].eventId).toBe('e1');
    // Both sides are reported, so whoever reads it can see who disagrees.
    expect(violations[0].entries.map((e) => e.sourceType).sort()).toEqual(['PAYOUT', 'SETTLEMENT']);
  });

  it('catches it across the two case spellings of one currency', () => {
    /*
      Settlement stores 'inr' and Payout stores 'INR'. A check that compared the raw strings
      would file them under different currencies and report no violation at all - which is the
      exact shape of the bug the read-boundary fold exists to prevent.
    */
    const entries = [
      entry({ sourceType: 'PAYOUT', eventId: 'e1', currency: 'INR' }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1', currency: 'inr' }),
    ];
    expect(holdsOnePath(entries)).toBe(false);
    expect(onePathViolations(entries)[0].currency).toBe('INR');
  });

  it('does not report one event claimed twice by the SAME path', () => {
    // Two payouts for one event across different periods is ordinary, not a double claim.
    const entries = [
      entry({ sourceType: 'PAYOUT', eventId: 'e1', sourceId: 'p1' }),
      entry({ sourceType: 'PAYOUT', eventId: 'e1', sourceId: 'p2' }),
    ];
    expect(holdsOnePath(entries)).toBe(true);
  });

  it('keeps organizations apart', () => {
    const entries = [
      entry({ sourceType: 'PAYOUT', eventId: 'e1', organizationId: 'orgA' }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1', organizationId: 'orgB' }),
    ];
    // An id colliding across tenants must not be reported as one event claimed twice.
    expect(holdsOnePath(entries)).toBe(true);
  });

  it('keeps currencies apart', () => {
    const entries = [
      entry({ sourceType: 'PAYOUT', eventId: 'e1', currency: 'INR' }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1', currency: 'USD' }),
    ];
    // One event genuinely can settle in two currencies through different paths.
    expect(holdsOnePath(entries)).toBe(true);
  });
});

describe('the invariant, over generated entry sets', () => {
  /** Deterministic generator - a failure here must be reproducible, not a lucky seed. */
  const rand = (seed: number) => {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  };

  it('reports a violation exactly when one was planted, over 200 cases', () => {
    const next = rand(20261001);
    let checked = 0;

    for (let run = 0; run < 200; run += 1) {
      const eventCount = 1 + Math.floor(next() * 6);
      const entries: FinanceEntry[] = [];
      const plantedOn = new Set<string>();

      for (let e = 0; e < eventCount; e += 1) {
        const eventId = `e${e}`;
        const double = next() < 0.3;
        if (double) {
          plantedOn.add(eventId);
          entries.push(entry({ sourceType: 'PAYOUT', eventId }));
          // Either spelling of the currency, because both occur in this database.
          entries.push(
            entry({ sourceType: 'SETTLEMENT', eventId, currency: next() < 0.5 ? 'inr' : 'INR' }),
          );
        } else {
          entries.push(entry({ sourceType: next() < 0.5 ? 'PAYOUT' : 'SETTLEMENT', eventId }));
        }
      }

      const found = new Set(onePathViolations(entries).map((v) => v.eventId));
      expect([...found].sort()).toEqual([...plantedOn].sort());
      checked += 1;
    }

    expect(checked).toBe(200);
  });
});

describe('what the check cannot see', () => {
  it('cannot detect a period payout overlapping an event settlement', () => {
    /*
      NOT a gap in this function - a gap in the data model, recorded here so a passing result is
      never mistaken for a proof.

      A Payout may cover a PERIOD across many events and carries no link to the bookings inside
      it: there is no PayoutLine and no Booking.payoutId. So its entry has eventId null, and
      nothing here can tell whether the settled event below is one of the events it contains.
    */
    const entries = [
      entry({
        sourceType: 'PAYOUT',
        eventId: null,
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-09-30T23:59:59.999Z',
      }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1' }),
    ];

    // Reports clean, and that is the honest limit of what entries alone can answer.
    expect(holdsOnePath(entries)).toBe(true);
  });

  it('ignores an entry with no readable currency rather than guessing one', () => {
    const entries = [
      entry({ sourceType: 'PAYOUT', eventId: 'e1', currency: '' }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1' }),
    ];
    expect(holdsOnePath(entries)).toBe(true);
  });
});
