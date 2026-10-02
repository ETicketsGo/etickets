import { describe, it, expect } from 'vitest';
import { onePathViolations, onePathReport, holdsOnePath, provesOnePath } from './finance-one-path';
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

/*
  ── PERIOD PAYOUTS ────────────────────────────────────────────────────────────────────
  A period payout used to be invisible here: it carried no link to the bookings inside it, so an
  overlap between it and an event settlement could not be detected at all. `PayoutAllocation`
  records that membership as the payout is written, so the overlap is now findable - for payouts
  raised under the allocation regime.
*/
describe('a period payout that records what it covers', () => {
  const period = (coveredEventIds: readonly string[] | undefined) =>
    entry({
      sourceType: 'PAYOUT',
      eventId: null,
      coveredEventIds,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-09-30T23:59:59.999Z',
    });

  it('catches an overlap that used to be undetectable', () => {
    const entries = [period(['e1', 'e2']), entry({ sourceType: 'SETTLEMENT', eventId: 'e1' })];

    const report = onePathReport(entries);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].eventId).toBe('e1');
    // Both claimants are named, so the report can be acted on rather than merely counted.
    expect(report.violations[0].entries.map((e) => e.sourceType).sort()).toEqual([
      'PAYOUT',
      'SETTLEMENT',
    ]);
    expect(report.gaps).toEqual([]);
    expect(holdsOnePath(entries)).toBe(false);
    expect(provesOnePath(entries)).toBe(false);
  });

  it('stays clean when the settled event is not one it covers', () => {
    const entries = [period(['e1', 'e2']), entry({ sourceType: 'SETTLEMENT', eventId: 'e9' })];
    const report = onePathReport(entries);
    expect(report.violations).toEqual([]);
    expect(report.gaps).toEqual([]);
    // Now a real proof, not merely an absence of evidence.
    expect(provesOnePath(entries)).toBe(true);
  });

  it('reports every overlapping event, not only the first', () => {
    const entries = [
      period(['e1', 'e2', 'e3']),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1' }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e3' }),
    ];
    expect(
      onePathReport(entries)
        .violations.map((v) => v.eventId)
        .sort(),
    ).toEqual(['e1', 'e3']);
  });

  it('does not flag two payouts covering the same event, which is the ordinary case', () => {
    /*
      A corrective payout legitimately revisits a booking an earlier payout included - that is
      the cursor's business, not a cross-path double claim. Flagging it would make the check cry
      wolf about the normal path.
    */
    const entries = [period(['e1']), period(['e1'])];
    const report = onePathReport(entries);
    expect(report.violations).toEqual([]);
    expect(provesOnePath(entries)).toBe(true);
  });

  it('keeps the comparison inside one organization and one currency', () => {
    const entries = [
      period(['e1']),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1', organizationId: 'other-org' }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1', currency: 'USD' }),
    ];
    expect(onePathReport(entries).violations).toEqual([]);
  });
});

describe('what the check still cannot see', () => {
  it('reports a LEGACY payout as an unproven gap, not as clean', () => {
    /*
      The distinction the whole design turns on. A payout raised before allocations existed has
      no membership, and inventing one would be inventing evidence. So it is neither a violation
      nor a pass: it is unproven, and it says so.
    */
    const entries = [
      entry({
        sourceType: 'PAYOUT',
        eventId: null,
        // Absent, NOT an empty array. Empty would claim it covers nothing.
        coveredEventIds: undefined,
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-09-30T23:59:59.999Z',
      }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1' }),
    ];

    const report = onePathReport(entries);
    // No double claim was FOUND...
    expect(report.violations).toEqual([]);
    expect(holdsOnePath(entries)).toBe(true);
    // ...but one could be hiding, and the gate must not read that as a proof.
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].reason).toBe('UNKNOWN_LEGACY_MEMBERSHIP');
    expect(report.gaps[0].entry.sourceType).toBe('PAYOUT');
    expect(provesOnePath(entries)).toBe(false);
  });

  it('treats an empty coverage list as proven, because it is a claim the data supports', () => {
    /*
      Not the same as the case above. An empty list came from allocations and says the payout
      covers no events; `undefined` says nobody knows. Collapsing them is the mistake that would
      let a release decide no payout covers an event when a legacy one already claimed it.
    */
    const entries = [
      entry({ sourceType: 'PAYOUT', eventId: null, coveredEventIds: [] }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1' }),
    ];
    const report = onePathReport(entries);
    expect(report.gaps).toEqual([]);
    expect(provesOnePath(entries)).toBe(true);
  });

  it('ignores an entry with no readable currency rather than guessing one', () => {
    const entries = [
      entry({ sourceType: 'PAYOUT', eventId: 'e1', currency: '' }),
      entry({ sourceType: 'SETTLEMENT', eventId: 'e1' }),
    ];
    expect(holdsOnePath(entries)).toBe(true);
  });

  it('does not let an unreadable currency become a membership gap', () => {
    // It is skipped entirely: reporting it as an unproven payout would be a different lie.
    const entries = [entry({ sourceType: 'PAYOUT', eventId: null, currency: '' })];
    expect(onePathReport(entries).gaps).toEqual([]);
  });
});
