import {
  companionCandidates,
  evaluateSeatOverride,
  isCasuallyReleasable,
  isHoldLive,
  normaliseReason,
  OVERRIDE_KINDS,
  OVERRIDE_LABEL,
  reducesSellableCapacity,
  shouldSuggestExpiry,
  type SeatState,
  type SeatStatus,
} from './seat-overrides';

const NOW = new Date('2026-08-08T12:00:00Z');

const seat = (over: Partial<SeatState> = {}): SeatState => ({
  status: 'AVAILABLE',
  overrideKind: null,
  holdExpiresAt: null,
  holdBookingId: null,
  ...over,
});

describe('evaluateSeatOverride — blocking', () => {
  it('blocks a free seat', () => {
    expect(evaluateSeatOverride(seat(), 'BLOCK', NOW).allowed).toBe(true);
  });

  it('NEVER blocks a sold seat', () => {
    // The most important rule here. Somebody holds a ticket; blocking does not un-sell it,
    // it just guarantees an argument at the door.
    const verdict = evaluateSeatOverride(seat({ status: 'SOLD' }), 'BLOCK', NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('SEAT_SOLD');
    // And it must point at the two honest alternatives.
    expect(verdict.message).toMatch(/cancel the show or refund/i);
  });

  it('refuses while a customer is mid-checkout, and says for how long', () => {
    const verdict = evaluateSeatOverride(
      seat({ status: 'HELD', holdExpiresAt: new Date(NOW.getTime() + 5 * 60_000) }),
      'BLOCK',
      NOW,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('SEAT_HELD');
    expect(verdict.message).toContain('5 minutes');
  });

  it('allows blocking once the hold has lapsed', () => {
    // The checkout is dead; the sweeper just has not run. Refusing here would make
    // overrides fail at random for reasons the operator cannot see or act on.
    const expired = seat({ status: 'HELD', holdExpiresAt: new Date(NOW.getTime() - 1000) });
    expect(evaluateSeatOverride(expired, 'BLOCK', NOW).allowed).toBe(true);
  });

  it('treats the expiry instant itself as lapsed', () => {
    const boundary = seat({ status: 'HELD', holdExpiresAt: NOW });
    expect(evaluateSeatOverride(boundary, 'BLOCK', NOW).allowed).toBe(true);
  });

  it('re-blocking an already blocked seat is allowed, so the kind can be corrected', () => {
    // Changing MANUAL_BLOCK to MAINTENANCE should not require a release-then-block dance
    // that momentarily puts the seat back on sale.
    expect(
      evaluateSeatOverride(seat({ status: 'BLOCKED', overrideKind: 'MANUAL_BLOCK' }), 'BLOCK', NOW)
        .allowed,
    ).toBe(true);
  });

  it('singularises a one-minute hold', () => {
    const verdict = evaluateSeatOverride(
      seat({ status: 'HELD', holdExpiresAt: new Date(NOW.getTime() + 60_000) }),
      'BLOCK',
      NOW,
    );
    expect(verdict.message).toContain('1 minute');
    expect(verdict.message).not.toContain('1 minutes');
  });
});

describe('evaluateSeatOverride — releasing', () => {
  it('releases a blocked seat', () => {
    expect(
      evaluateSeatOverride(seat({ status: 'BLOCKED', overrideKind: 'HOUSE' }), 'RELEASE', NOW)
        .allowed,
    ).toBe(true);
  });

  it('refuses to release a seat that was never blocked', () => {
    const verdict = evaluateSeatOverride(seat(), 'RELEASE', NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('SEAT_NOT_BLOCKED');
  });

  it('refuses to release a sold seat', () => {
    // "Release" must never be a back door to freeing inventory somebody paid for.
    expect(evaluateSeatOverride(seat({ status: 'SOLD' }), 'RELEASE', NOW).code).toBe('SEAT_SOLD');
  });

  it('refuses to release a live hold', () => {
    expect(
      evaluateSeatOverride(
        seat({ status: 'HELD', holdExpiresAt: new Date(NOW.getTime() + 60_000) }),
        'RELEASE',
        NOW,
      ).code,
    ).toBe('SEAT_HELD');
  });

  it('an expired hold is not releasable either — it is not a block', () => {
    const expired = seat({ status: 'HELD', holdExpiresAt: new Date(NOW.getTime() - 1000) });
    expect(evaluateSeatOverride(expired, 'RELEASE', NOW).code).toBe('SEAT_NOT_BLOCKED');
  });
});

describe('isHoldLive', () => {
  it('is false with no hold at all', () => {
    expect(isHoldLive({ holdExpiresAt: null }, NOW)).toBe(false);
  });
  it('is true strictly before expiry', () => {
    expect(isHoldLive({ holdExpiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe(true);
  });
  it('is false at and after expiry', () => {
    expect(isHoldLive({ holdExpiresAt: NOW }, NOW)).toBe(false);
    expect(isHoldLive({ holdExpiresAt: new Date(NOW.getTime() - 1) }, NOW)).toBe(false);
  });
});

describe('emergency blocks', () => {
  it('are not casually releasable', () => {
    // A gangway keep-clear must not vanish because somebody was tidying the seat map.
    expect(isCasuallyReleasable('EMERGENCY')).toBe(false);
  });

  it('every other kind is', () => {
    for (const kind of OVERRIDE_KINDS.filter((k) => k !== 'EMERGENCY')) {
      expect(isCasuallyReleasable(kind)).toBe(true);
    }
  });
});

describe('maintenance expiry', () => {
  it('suggests an expiry for open-ended maintenance', () => {
    expect(shouldSuggestExpiry('MAINTENANCE', null)).toBe(true);
  });
  it('says nothing when one was given', () => {
    expect(shouldSuggestExpiry('MAINTENANCE', NOW)).toBe(false);
  });
  it('does not nag about other kinds', () => {
    // A house seat held for the whole run is normal, not an oversight.
    expect(shouldSuggestExpiry('HOUSE', null)).toBe(false);
    expect(shouldSuggestExpiry('EMERGENCY', null)).toBe(false);
  });
});

describe('normaliseReason', () => {
  it('keeps real text, trimmed', () => {
    expect(normaliseReason('  broken recliner  ')).toBe('broken recliner');
  });
  it('rejects empty and whitespace-only', () => {
    // A block nobody can explain is a seat nobody dares release.
    expect(normaliseReason('')).toBeNull();
    expect(normaliseReason('   \t\n ')).toBeNull();
  });
});

describe('companionCandidates', () => {
  const row = (status: SeatStatus = 'AVAILABLE') => [
    { seatId: 's1', row: 'A', colIndex: 1, kind: 'SEAT', status },
    { seatId: 's2', row: 'A', colIndex: 2, kind: 'WHEELCHAIR', status: 'AVAILABLE' as SeatStatus },
    { seatId: 's3', row: 'A', colIndex: 3, kind: 'SEAT', status },
    { seatId: 's9', row: 'B', colIndex: 2, kind: 'SEAT', status },
  ];

  it('offers both immediate neighbours in the same row', () => {
    expect(companionCandidates(row(), 's2')).toEqual(['s1', 's3']);
  });

  it('never crosses rows', () => {
    // B2 is directly behind A2, which is not sitting together.
    expect(companionCandidates(row(), 's2')).not.toContain('s9');
  });

  it('skips neighbours that are already taken', () => {
    // Suggesting them would produce a refusal the operator can do nothing about.
    expect(companionCandidates(row('SOLD'), 's2')).toEqual([]);
  });

  it('returns nothing for a seat that is not a wheelchair space', () => {
    expect(companionCandidates(row(), 's1')).toEqual([]);
  });

  it('returns nothing for an unknown seat', () => {
    expect(companionCandidates(row(), 'nope')).toEqual([]);
  });

  it('excludes an aisle gap as a companion seat', () => {
    const withGap = [
      { seatId: 'g', row: 'A', colIndex: 1, kind: 'GAP', status: 'AVAILABLE' as SeatStatus },
      { seatId: 'w', row: 'A', colIndex: 2, kind: 'WHEELCHAIR', status: 'AVAILABLE' as SeatStatus },
    ];
    expect(companionCandidates(withGap, 'w')).toEqual([]);
  });
});

describe('reporting vocabulary', () => {
  it('every override kind has an operator-facing label', () => {
    for (const kind of OVERRIDE_KINDS) {
      expect(OVERRIDE_LABEL[kind]).toBeTruthy();
    }
  });

  it('every kind reduces sellable capacity', () => {
    // Including house seats. Reporting 100% occupancy because the only empty seats were
    // comped would flatter every number finance looks at.
    for (const kind of OVERRIDE_KINDS) {
      expect(reducesSellableCapacity(kind)).toBe(true);
    }
  });
});
