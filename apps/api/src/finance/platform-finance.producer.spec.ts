import {
  platformFinanceEntry,
  type PlatformAllocationRow,
  type PlatformPayoutRow,
} from './platform-finance.producer';
import { financeAttributionError } from '@eticketsgo/shared-types';

/**
 * What a payout's evidence actually supports, and what it refuses to claim.
 *
 * Integer amounts are asserted throughout rather than DTO shape: a producer that returns the
 * right fields with the wrong numbers is worse than one that fails to compile.
 */

const payout = (over: Partial<PlatformPayoutRow> = {}): PlatformPayoutRow => ({
  id: 'p1',
  organizationId: 'org1',
  eventId: null,
  currency: 'INR',
  status: 'PAID',
  periodStart: null,
  periodEnd: new Date('2026-09-30T00:00:00Z'),
  grossMinor: 0,
  bookingFeeMinor: 0,
  paymentFeeMinor: 0,
  refundMinor: 0,
  netMinor: 0,
  allocatedFrom: new Date('2026-09-30T00:00:00Z'),
  ...over,
});

const alloc = (over: Partial<PlatformAllocationRow> = {}): PlatformAllocationRow => ({
  bookingId: 'b1',
  eventId: 'e1',
  currency: 'INR',
  allocatedNetMinor: 0,
  subtotalMinor: 0,
  discountMinor: 0,
  organizerFeeMinor: 0,
  refundShareMinor: 0,
  bookingFeeMinor: 0,
  paymentFeeMinor: 0,
  ...over,
});

/**
 * A consistent allocation-backed payout: the allocations are built first and the payout totals
 * are derived from them, so the fixture cannot accidentally be the thing under test.
 */
function consistent(rows: PlatformAllocationRow[], over: Partial<PlatformPayoutRow> = {}) {
  const sum = (k: keyof PlatformAllocationRow) => rows.reduce((t, r) => t + (r[k] as number), 0);
  const net =
    sum('subtotalMinor') -
    sum('discountMinor') -
    sum('organizerFeeMinor') -
    sum('refundShareMinor');
  return {
    row: payout({
      grossMinor: sum('subtotalMinor'),
      bookingFeeMinor: sum('bookingFeeMinor'),
      paymentFeeMinor: sum('paymentFeeMinor'),
      refundMinor: sum('refundShareMinor'),
      netMinor: net,
      ...over,
    }),
    rows,
  };
}

describe('an allocation-backed payout', () => {
  it('projects an event payout with its totals and decomposition', () => {
    const { row, rows } = consistent(
      [
        alloc({
          bookingId: 'b1',
          eventId: 'e1',
          subtotalMinor: 150_000,
          discountMinor: 10_000,
          organizerFeeMinor: 7_500,
          bookingFeeMinor: 300,
          paymentFeeMinor: 200,
          allocatedNetMinor: 132_500,
        }),
      ],
      { eventId: 'e1' },
    );
    const { entry, integrity } = platformFinanceEntry(row, rows);

    expect(integrity).toEqual([]);
    expect(entry.attribution).toBe('AUTHORITATIVE');
    expect(entry.eventId).toBe('e1');
    expect(entry.coveredEventIds).toBeUndefined();
    expect(entry.state).toBe('PAID');
    expect(entry.sourceStatus).toBe('PAID');

    expect(entry.money.organizerNetMinor).toBe(132_500);
    expect(entry.money.grossFaceValueMinor).toBe(150_000);
    expect(entry.money.discountMinor).toBe(10_000);
    expect(entry.money.refundsMinor).toBe(0);
    expect(financeAttributionError(entry)).toBeNull();
  });

  it('exposes a period payout event membership from its allocations', () => {
    const { row, rows } = consistent([
      alloc({ bookingId: 'b1', eventId: 'e2', subtotalMinor: 10_000, allocatedNetMinor: 10_000 }),
      alloc({ bookingId: 'b2', eventId: 'e1', subtotalMinor: 20_000, allocatedNetMinor: 20_000 }),
      alloc({ bookingId: 'b3', eventId: 'e2', subtotalMinor: 30_000, allocatedNetMinor: 30_000 }),
    ]);
    const { entry, integrity } = platformFinanceEntry(row, rows);

    expect(integrity).toEqual([]);
    // The gap this closes: the payout itself names no event.
    expect(entry.eventId).toBeNull();
    expect(entry.attribution).toBe('AUTHORITATIVE');
    expect(entry.coveredEventIds).toEqual(['e1', 'e2']);
    expect(entry.money.organizerNetMinor).toBe(60_000);
  });

  it('reconciles every stored total against the allocation sums', () => {
    const { row, rows } = consistent([
      alloc({
        bookingId: 'b1',
        subtotalMinor: 99_999,
        discountMinor: 1,
        organizerFeeMinor: 4_999,
        refundShareMinor: 999,
        bookingFeeMinor: 1,
        paymentFeeMinor: 2,
        allocatedNetMinor: 94_000,
      }),
    ]);
    const { entry, integrity } = platformFinanceEntry(row, rows);
    expect(integrity).toEqual([]);
    expect(entry.money.grossFaceValueMinor).toBe(99_999);
    expect(entry.money.refundsMinor).toBe(999);
    expect(entry.money.organizerNetMinor).toBe(94_000);
  });
});

describe('fee semantics', () => {
  const { row, rows } = consistent([
    alloc({
      bookingId: 'b1',
      subtotalMinor: 12_000,
      organizerFeeMinor: 1_000,
      bookingFeeMinor: 3_000,
      paymentFeeMinor: 2_000,
      allocatedNetMinor: 11_000,
    }),
  ]);

  it('marks the organizer fee deducted and the customer-borne fees not', () => {
    const { entry } = platformFinanceEntry(row, rows);
    const byKey = Object.fromEntries(entry.money.fees!.map((f) => [f.key, f]));
    expect(byKey.PLATFORM).toEqual({ key: 'PLATFORM', amountMinor: 1_000, deducted: true });
    expect(byKey.BOOKING).toEqual({ key: 'BOOKING', amountMinor: 3_000, deducted: false });
    expect(byKey.PAYMENT_PROCESSING).toEqual({
      key: 'PAYMENT_PROCESSING',
      amountMinor: 2_000,
      deducted: false,
    });
  });

  it('gives the wrong organizer amount if every fee line is blindly subtracted', () => {
    /*
      PERMANENT REGRESSION EVIDENCE. Only the organizer fee came out of the organizer's money.
      Subtracting all three understates what they are owed by exactly the customer-borne fees,
      and the resulting number looks entirely plausible.
    */
    const { entry } = platformFinanceEntry(row, rows);
    const fees = entry.money.fees!;
    const actuallyDeducted = fees.reduce((t, f) => t + (f.deducted ? f.amountMinor : 0), 0);
    const naive = fees.reduce((t, f) => t + f.amountMinor, 0);

    expect(actuallyDeducted).toBe(1_000);
    expect(naive).toBe(6_000);
    // gross - discount - deducted fees - refunds reproduces the net; the naive sum does not.
    expect(entry.money.grossFaceValueMinor! - entry.money.discountMinor! - actuallyDeducted).toBe(
      entry.money.organizerNetMinor,
    );
    expect(entry.money.grossFaceValueMinor! - entry.money.discountMinor! - naive).not.toBe(
      entry.money.organizerNetMinor,
    );
  });

  it('proves bookingFee and paymentFee do not participate in the net equation', () => {
    // Were either included, the equation check would fail by exactly its amount.
    const { integrity, entry } = platformFinanceEntry(row, rows);
    expect(integrity).toEqual([]);
    expect(entry.money.organizerNetMinor).toBe(11_000);
  });
});

describe('a legacy payout', () => {
  const legacy = (over: Partial<PlatformPayoutRow> = {}) =>
    payout({
      allocatedFrom: null,
      grossMinor: 90_000,
      bookingFeeMinor: 700,
      paymentFeeMinor: 300,
      refundMinor: 5_000,
      netMinor: 80_000,
      ...over,
    });

  it('keeps every total the row genuinely stores', () => {
    const { entry, integrity } = platformFinanceEntry(legacy(), []);
    expect(integrity).toEqual([]);
    // A real historical payout amount, still visible.
    expect(entry.money.organizerNetMinor).toBe(80_000);
    expect(entry.money.grossFaceValueMinor).toBe(90_000);
    expect(entry.money.refundsMinor).toBe(5_000);
    expect(entry.state).toBe('PAID');
  });

  it('omits the deductions the row never stored, rather than calling them zero', () => {
    /*
      Payout stores no discountMinor and no organizerFeeMinor. `gross - refund - net` gives only
      their COMBINED effect (90 000 - 5 000 - 80 000 = 5 000) and cannot prove either component,
      so neither is emitted.
    */
    const { entry } = platformFinanceEntry(legacy(), []);
    expect(entry.money.discountMinor).toBeUndefined();
    expect(entry.money.fees!.map((f) => f.key)).toEqual(['BOOKING', 'PAYMENT_PROCESSING']);
    expect(entry.money.fees!.some((f) => f.key === 'PLATFORM')).toBe(false);
  });

  it('still reports the fees the row DOES store', () => {
    const { entry } = platformFinanceEntry(legacy(), []);
    const byKey = Object.fromEntries(entry.money.fees!.map((f) => [f.key, f.amountMinor]));
    expect(byKey.BOOKING).toBe(700);
    expect(byKey.PAYMENT_PROCESSING).toBe(300);
  });

  it('reports unknown event attribution for a period payout', () => {
    const { entry } = platformFinanceEntry(legacy({ eventId: null }), []);
    expect(entry.attribution).toBe('UNKNOWN_LEGACY');
    expect(entry.eventId).toBeNull();
    expect(entry.coveredEventIds).toBeUndefined();
    expect(financeAttributionError(entry)).toBeNull();
  });

  it('keeps AUTHORITATIVE attribution for a legacy EVENT payout', () => {
    /*
      Legacy-ness costs a payout its decomposition always, and its attribution only when it is a
      period payout. An event-scoped payout names its event on the row, which is authoritative
      whenever it was raised - treating it as unknown would discard real evidence.
    */
    const { entry } = platformFinanceEntry(legacy({ eventId: 'e7' }), []);
    expect(entry.attribution).toBe('AUTHORITATIVE');
    expect(entry.eventId).toBe('e7');
    // Still no decomposition, though.
    expect(entry.money.discountMinor).toBeUndefined();
  });
});

describe('proven zero is not the same statement as unknown', () => {
  it('serializes a proven-zero discount differently from an unavailable one', () => {
    const proven = consistent([
      alloc({
        bookingId: 'b1',
        subtotalMinor: 50_000,
        discountMinor: 0,
        allocatedNetMinor: 50_000,
      }),
    ]);
    const provenEntry = platformFinanceEntry(proven.row, proven.rows).entry;
    const legacyEntry = platformFinanceEntry(
      payout({ allocatedFrom: null, grossMinor: 50_000, netMinor: 50_000 }),
      [],
    ).entry;

    // Same money, materially different financial statements.
    expect(provenEntry.money.discountMinor).toBe(0);
    expect(legacyEntry.money.discountMinor).toBeUndefined();
    expect('discountMinor' in provenEntry.money).toBe(true);
    expect('discountMinor' in legacyEntry.money).toBe(false);
    // And they must survive serialization as different things.
    expect(JSON.stringify(provenEntry.money)).toContain('discountMinor');
    expect(JSON.stringify(legacyEntry.money)).not.toContain('discountMinor');
  });

  it('serializes a proven-zero organizer fee differently from an unavailable one', () => {
    const proven = consistent([
      alloc({
        bookingId: 'b1',
        subtotalMinor: 50_000,
        organizerFeeMinor: 0,
        allocatedNetMinor: 50_000,
      }),
    ]);
    const provenEntry = platformFinanceEntry(proven.row, proven.rows).entry;
    const legacyEntry = platformFinanceEntry(
      payout({ allocatedFrom: null, grossMinor: 50_000, netMinor: 50_000 }),
      [],
    ).entry;

    const platformLine = (e: typeof provenEntry) => e.money.fees!.find((f) => f.key === 'PLATFORM');
    // Proven zero: the line exists and says zero came out.
    expect(platformLine(provenEntry)).toEqual({ key: 'PLATFORM', amountMinor: 0, deducted: true });
    // Unknown: no line at all, because the row cannot prove one.
    expect(platformLine(legacyEntry)).toBeUndefined();
  });
});

describe('disagreeing evidence is reported, never repaired', () => {
  const broken = (
    field: keyof PlatformPayoutRow,
    wrong: number,
  ): ReturnType<typeof platformFinanceEntry> => {
    const { row, rows } = consistent([
      alloc({
        bookingId: 'b1',
        subtotalMinor: 100_000,
        discountMinor: 5_000,
        organizerFeeMinor: 5_000,
        refundShareMinor: 10_000,
        bookingFeeMinor: 400,
        paymentFeeMinor: 600,
        allocatedNetMinor: 80_000,
      }),
    ]);
    return platformFinanceEntry({ ...row, [field]: wrong }, rows);
  };

  const CORRUPTIBLE = ['grossMinor', 'bookingFeeMinor', 'paymentFeeMinor', 'refundMinor'] as const;

  it.each(CORRUPTIBLE)('reports corrupted %s without producing a healthy entry', (field) => {
    const { entry, integrity } = broken(field, 123_456);
    const found = integrity.filter((f) => f.code === 'TOTALS_DISAGREE' && f.field === field);
    expect(found).toHaveLength(1);
    expect(found[0].stored).toBe(123_456);
    // The entry is NOT normal: a reader cannot mistake it for healthy.
    expect(entry.state).toBe('ATTENTION_REQUIRED');
    expect(entry.sourceStatus).toBe('PAID');
  });

  it('reports a corrupted net as both a total and an equation disagreement', () => {
    const { entry, integrity } = broken('netMinor', 999);
    expect(integrity.map((f) => f.code).sort()).toEqual(['EQUATION_DISAGREES', 'TOTALS_DISAGREE']);
    expect(entry.state).toBe('ATTENTION_REQUIRED');
    // The stored figure is still reported as-is. Not silently replaced by the derived one.
    expect(entry.money.organizerNetMinor).toBe(999);
  });

  it('does not repair the number it reports', () => {
    /*
      The temptation is to show the allocation-derived total because it "looks right". That hides
      a real problem behind a plausible figure. The stored value is the money record and is what
      is returned; the disagreement travels alongside it.
    */
    const { entry, integrity } = broken('grossMinor', 1);
    expect(entry.money.grossFaceValueMinor).toBe(1);
    expect(integrity[0].derived).toBe(100_000);
  });

  it('reports allocations supplied for a payout that recorded none, and vice versa', () => {
    const { integrity, entry } = platformFinanceEntry(payout({ grossMinor: 10, netMinor: 10 }), []);
    expect(integrity.map((f) => f.code)).toContain('MISSING_ALLOCATIONS');
    expect(entry.state).toBe('ATTENTION_REQUIRED');
    // Decomposition is withheld: a caller that forgot to load rows must not look like proof.
    expect(entry.money.discountMinor).toBeUndefined();
  });

  it('reports an allocation naming a different event from its event payout', () => {
    const { row, rows } = consistent(
      [alloc({ bookingId: 'b1', eventId: 'OTHER', subtotalMinor: 100, allocatedNetMinor: 100 })],
      { eventId: 'e1' },
    );
    const { integrity } = platformFinanceEntry(row, rows);
    expect(integrity.map((f) => f.code)).toContain('ALLOCATION_EVENT_MISMATCH');
  });

  it('reports an allocation in a different currency from its payout', () => {
    const { row, rows } = consistent([
      alloc({ bookingId: 'b1', currency: 'USD', subtotalMinor: 100, allocatedNetMinor: 100 }),
    ]);
    const { integrity } = platformFinanceEntry(row, rows);
    expect(integrity.map((f) => f.code)).toContain('ALLOCATION_CURRENCY_MISMATCH');
  });

  it('guesses no state for a status it cannot map', () => {
    const { entry, integrity } = platformFinanceEntry(
      payout({ allocatedFrom: null, status: 'SOMETHING_NEW', netMinor: 1 }),
      [],
    );
    expect(integrity.map((f) => f.code)).toContain('UNMAPPED_STATUS');
    expect(entry.state).toBe('ATTENTION_REQUIRED');
  });
});

describe('lifecycle', () => {
  it.each([
    ['PENDING', 'PENDING'],
    ['SCHEDULED', 'IN_PROGRESS'],
    ['PAID', 'PAID'],
    ['FAILED', 'ATTENTION_REQUIRED'],
  ])('maps payout %s to %s', (status, expected) => {
    const { entry } = platformFinanceEntry(
      payout({ allocatedFrom: null, status, netMinor: 1_000 }),
      [],
    );
    expect(entry.state).toBe(expected);
    // The original always travels alongside, so nothing is lost by normalizing.
    expect(entry.sourceStatus).toBe(status);
  });
});

describe('currency', () => {
  it('folds case at the read boundary without rewriting anything', () => {
    const { entry } = platformFinanceEntry(
      payout({ allocatedFrom: null, currency: 'inr', netMinor: 10 }),
      [],
    );
    expect(entry.currency).toBe('INR');
  });

  it('produces one entry per payout, so currencies stay separate', () => {
    /*
      There is no cross-currency anything here by construction: a payout has exactly one currency
      and becomes exactly one entry. Separation is the caller's grouping problem, not an
      arithmetic one.
    */
    const inr = platformFinanceEntry(
      payout({ id: 'p-inr', allocatedFrom: null, currency: 'INR', netMinor: 10_000 }),
      [],
    ).entry;
    const usd = platformFinanceEntry(
      payout({ id: 'p-usd', allocatedFrom: null, currency: 'USD', netMinor: 20_000 }),
      [],
    ).entry;
    expect([inr.currency, usd.currency]).toEqual(['INR', 'USD']);
    expect(inr.sourceId).not.toBe(usd.sourceId);
  });

  it('flags an unreadable currency rather than inventing one', () => {
    const { entry, integrity } = platformFinanceEntry(
      payout({ allocatedFrom: null, currency: '   ', netMinor: 10 }),
      [],
    );
    expect(integrity.map((f) => f.code)).toContain('CURRENCY_UNREADABLE');
    expect(entry.state).toBe('ATTENTION_REQUIRED');
  });
});
