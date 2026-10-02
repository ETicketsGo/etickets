import { describe, it, expect } from 'vitest';
import {
  financeAttributionError,
  financeClaimedEvents,
  type FinanceAttribution,
  type FinanceEntry,
} from './finance-entry';
import { onePathReport, provesOnePath } from './finance-one-path';

/**
 * Event attribution as an explicit claim rather than something inferred from what a producer
 * happened to omit.
 *
 * The distinction these tests protect is the one the whole allocation track exists for: an
 * amount can be authoritative while its event membership is not, and reading the second as
 * "covers nothing" is what would pay the same revenue twice.
 */

const entry = (over: Partial<FinanceEntry> & { attribution: FinanceAttribution }): FinanceEntry =>
  ({
    sourceType: 'PAYOUT',
    sourceId: 'p1',
    sourceStatus: 'PAID',
    state: 'PAID',
    organizationId: 'org1',
    currency: 'INR',
    eventId: null,
    periodStart: null,
    periodEnd: null,
    money: { organizerNetMinor: 10_000 },
    ...over,
  }) as FinanceEntry;

describe('an entry has to state what it can prove', () => {
  it('accepts an event-scoped entry that names its event', () => {
    const e = entry({ attribution: 'AUTHORITATIVE', eventId: 'e1' });
    expect(financeAttributionError(e)).toBeNull();
    expect(financeClaimedEvents(e)).toEqual(['e1']);
  });

  it('accepts a period entry that lists what its allocations proved', () => {
    const e = entry({ attribution: 'AUTHORITATIVE', coveredEventIds: ['e1', 'e2'] });
    expect(financeAttributionError(e)).toBeNull();
    expect(financeClaimedEvents(e)).toEqual(['e1', 'e2']);
  });

  it('accepts a proven-empty coverage list, which is a real and different claim', () => {
    /*
      The allocations were read and they cover no events. Not the same as nobody having looked,
      and the only thing separating the two is the attribution field.
    */
    const e = entry({ attribution: 'AUTHORITATIVE', coveredEventIds: [] });
    expect(financeAttributionError(e)).toBeNull();
    expect(financeClaimedEvents(e)).toEqual([]);
  });

  it('accepts a legacy entry that claims nothing about events', () => {
    const e = entry({ attribution: 'UNKNOWN_LEGACY' });
    expect(financeAttributionError(e)).toBeNull();
    // Not [] - that would be a claim. Claimed events is empty because nothing is CLAIMED.
    expect(financeClaimedEvents(e)).toEqual([]);
  });

  describe('refuses the combinations that would be dangerous', () => {
    it('refuses a legacy entry that names an event', () => {
      const e = entry({ attribution: 'UNKNOWN_LEGACY', eventId: 'e1' });
      expect(financeAttributionError(e)).toMatch(/claims proof it does not have/);
    });

    it('refuses a legacy entry that lists covered events', () => {
      const e = entry({ attribution: 'UNKNOWN_LEGACY', coveredEventIds: ['e1'] });
      expect(financeAttributionError(e)).toMatch(/claims proof it does not have/);
    });

    it('refuses an authoritative entry that proves no events at all', () => {
      /*
        THE COLLAPSE THIS EXISTS TO PREVENT. Without the check, an AUTHORITATIVE entry with
        neither field is byte-identical to a legacy one, so a producer that forgot to populate
        coveredEventIds would silently assert "covers nothing" about a payout nobody examined.
      */
      const e = entry({ attribution: 'AUTHORITATIVE' });
      expect(financeAttributionError(e)).toMatch(/indistinguishable from UNKNOWN_LEGACY/);
    });

    it('refuses an entry that answers the question twice', () => {
      const e = entry({ attribution: 'AUTHORITATIVE', eventId: 'e1', coveredEventIds: ['e2'] });
      expect(financeAttributionError(e)).toMatch(/two answers/);
    });
  });

  it('claims nothing from a non-authoritative entry, whatever its fields say', () => {
    /*
      `financeClaimedEvents` gates on the ATTRIBUTION, not on the presence of an eventId. So a
      malformed legacy entry that names an event still claims nothing - the safe reading - and the
      error is what tells a caller the entry is broken.

      That layering matters for the inverse case: a malformed AUTHORITATIVE entry with no events
      also returns an empty list, which is indistinguishable from "proven empty". Which is exactly
      why the one-path check consults `financeAttributionError` BEFORE trusting the list.
    */
    const lying = entry({ attribution: 'UNKNOWN_LEGACY', eventId: 'e1' });
    expect(financeClaimedEvents(lying)).toEqual([]);
    expect(financeAttributionError(lying)).not.toBeNull();

    const emptyLooksProven = entry({ attribution: 'AUTHORITATIVE' });
    expect(financeClaimedEvents(emptyLooksProven)).toEqual([]);
    expect(financeAttributionError(emptyLooksProven)).not.toBeNull();
  });
});

describe('the one-path check reads the claim instead of guessing it', () => {
  const settlement = (eventId: string): FinanceEntry =>
    entry({
      attribution: 'AUTHORITATIVE',
      sourceType: 'SETTLEMENT',
      sourceId: `s-${eventId}`,
      sourceStatus: 'TRANSFERRED',
      eventId,
    });

  it('finds an overlap a period payout proves', () => {
    const report = onePathReport([
      entry({ attribution: 'AUTHORITATIVE', coveredEventIds: ['e1', 'e2'] }),
      settlement('e1'),
    ]);
    expect(report.violations.map((v) => v.eventId)).toEqual(['e1']);
    expect(report.gaps).toEqual([]);
  });

  it('reports a legacy payout as unproven rather than clean', () => {
    const entries = [entry({ attribution: 'UNKNOWN_LEGACY' }), settlement('e1')];
    const report = onePathReport(entries);
    expect(report.violations).toEqual([]);
    expect(report.gaps.map((g) => g.reason)).toEqual(['UNKNOWN_LEGACY_MEMBERSHIP']);
    expect(provesOnePath(entries)).toBe(false);
  });

  it('reports a MALFORMED entry separately, because that is a producer bug', () => {
    /*
      A broken producer must not be able to shrink the checked population silently. The two gap
      reasons lead somewhere different: one is a known historical limitation, the other means
      somebody has to fix code.
    */
    const entries = [
      entry({ attribution: 'AUTHORITATIVE' }), // proves nothing, so it is malformed
      settlement('e1'),
    ];
    const report = onePathReport(entries);
    expect(report.violations).toEqual([]);
    expect(report.gaps.map((g) => g.reason)).toEqual(['MALFORMED_ATTRIBUTION']);
    expect(provesOnePath(entries)).toBe(false);
  });

  it('does not let a malformed legacy entry assert ownership of an event', () => {
    /*
      The attack this closes. An entry saying UNKNOWN_LEGACY while naming e1 would, if believed,
      make e1 look claimed by the platform path - and could mask a genuine provider overlap, or
      invent one. It is treated as unknown instead.
    */
    const entries = [entry({ attribution: 'UNKNOWN_LEGACY', eventId: 'e1' }), settlement('e1')];
    const report = onePathReport(entries);
    expect(report.violations).toEqual([]);
    expect(report.gaps.map((g) => g.reason)).toEqual(['MALFORMED_ATTRIBUTION']);
  });

  it('still proves a clean set when every entry is authoritative', () => {
    const entries = [
      entry({ attribution: 'AUTHORITATIVE', coveredEventIds: ['e1'] }),
      settlement('e9'),
    ];
    expect(provesOnePath(entries)).toBe(true);
  });
});
