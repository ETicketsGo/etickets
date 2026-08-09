import {
  compareLayouts,
  evaluateLayoutOperation,
  isSellableKind,
  resolveEffectiveLayout,
  type ComparableSeat,
  type LayoutCommitments,
  type LayoutVersion,
} from './seat-layout-versioning';

const at = (iso: string) => new Date(iso);

/**
 * Spread the overrides LAST so an explicit `effectiveFrom: null` survives.
 *
 * Written with `??` first, it did not: passing null fell through to the default date and the
 * publishedAt-fallback test silently exercised the wrong path.
 */
const version = (over: Partial<LayoutVersion> = {}): LayoutVersion => ({
  id: `v${over.version ?? 1}`,
  version: 1,
  status: 'PUBLISHED',
  effectiveFrom: at('2026-01-01T00:00:00Z'),
  publishedAt: at('2026-01-01T00:00:00Z'),
  createdAt: at('2026-01-01T00:00:00Z'),
  ...over,
});

const commitments = (over: Partial<LayoutCommitments> = {}): LayoutCommitments => ({
  futureShows: 0,
  historicalShows: 0,
  otherPublishedVersions: 1,
  ...over,
});

describe('resolveEffectiveLayout', () => {
  it('returns null when a screen has no layout at all', () => {
    expect(resolveEffectiveLayout([], at('2026-06-01T00:00:00Z'))).toBeNull();
  });

  it('uses the only published version', () => {
    const v1 = version({ version: 1 });
    expect(resolveEffectiveLayout([v1], at('2026-06-01T00:00:00Z'))?.version).toBe(1);
  });

  it('ignores drafts entirely', () => {
    // A draft is work in progress. Scheduling against it would let an operator sell seats
    // from a layout they have not finished designing.
    const draft = version({ version: 2, status: 'DRAFT' });
    const published = version({ version: 1 });
    expect(resolveEffectiveLayout([draft, published], at('2026-06-01T00:00:00Z'))?.version).toBe(1);
  });

  it('ignores archived versions for NEW shows', () => {
    const archived = version({
      version: 2,
      status: 'ARCHIVED',
      effectiveFrom: at('2026-02-01T00:00:00Z'),
    });
    const live = version({ version: 3, effectiveFrom: at('2026-01-15T00:00:00Z') });
    expect(resolveEffectiveLayout([archived, live], at('2026-06-01T00:00:00Z'))?.version).toBe(3);
  });

  it('a future-dated version does NOT apply to a show before it takes effect', () => {
    // The whole point of "activate a future version": tonight is untouched.
    const current = version({ version: 1, effectiveFrom: at('2026-01-01T00:00:00Z') });
    const future = version({ version: 2, effectiveFrom: at('2026-07-01T00:00:00Z') });
    expect(resolveEffectiveLayout([current, future], at('2026-06-30T23:00:00Z'))?.version).toBe(1);
  });

  it('the future version applies once the show starts after it', () => {
    const current = version({ version: 1, effectiveFrom: at('2026-01-01T00:00:00Z') });
    const future = version({ version: 2, effectiveFrom: at('2026-07-01T00:00:00Z') });
    expect(resolveEffectiveLayout([current, future], at('2026-07-01T00:00:00Z'))?.version).toBe(2);
    expect(resolveEffectiveLayout([current, future], at('2026-08-01T00:00:00Z'))?.version).toBe(2);
  });

  it('takes effect exactly AT the boundary instant, not a moment later', () => {
    const future = version({ version: 2, effectiveFrom: at('2026-07-01T00:00:00Z') });
    const before = version({ version: 1, effectiveFrom: at('2026-01-01T00:00:00Z') });
    expect(resolveEffectiveLayout([before, future], at('2026-06-30T23:59:59.999Z'))?.version).toBe(
      1,
    );
    expect(resolveEffectiveLayout([before, future], at('2026-07-01T00:00:00Z'))?.version).toBe(2);
  });

  it('orders on effective date, not version number', () => {
    // v3 was published first but dated later; v4 was published as a hotfix dated earlier.
    // A show tomorrow must get v4, because that is what is actually in effect.
    const v3 = version({ version: 3, effectiveFrom: at('2026-09-01T00:00:00Z') });
    const v4 = version({ version: 4, effectiveFrom: at('2026-02-01T00:00:00Z') });
    expect(resolveEffectiveLayout([v3, v4], at('2026-03-01T00:00:00Z'))?.version).toBe(4);
  });

  it('breaks a same-instant tie on the higher version', () => {
    const a = version({ version: 5, effectiveFrom: at('2026-03-01T00:00:00Z') });
    const b = version({ version: 6, effectiveFrom: at('2026-03-01T00:00:00Z') });
    expect(resolveEffectiveLayout([a, b], at('2026-04-01T00:00:00Z'))?.version).toBe(6);
    // Order of the input must not decide it.
    expect(resolveEffectiveLayout([b, a], at('2026-04-01T00:00:00Z'))?.version).toBe(6);
  });

  it('falls back to publishedAt when no explicit effective date was given', () => {
    const v = version({ version: 1, effectiveFrom: null, publishedAt: at('2026-01-05T00:00:00Z') });
    expect(resolveEffectiveLayout([v], at('2026-02-01T00:00:00Z'))?.version).toBe(1);
    expect(resolveEffectiveLayout([v], at('2026-01-04T00:00:00Z'))).toBeNull();
  });

  it('falls back to createdAt when a published row carries no dates at all', () => {
    /*
      Not a hypothetical. `status` defaults to PUBLISHED while both date columns default to
      null, so any seed, fixture or caller that does not set them writes exactly this row.
      Without the fallback the screen resolves to "no layout in effect" and becomes
      unschedulable with an error nobody can act on — which is how three existing integration
      suites broke when versioning first landed.
    */
    const v = version({
      version: 1,
      effectiveFrom: null,
      publishedAt: null,
      createdAt: at('2026-01-05T00:00:00Z'),
    });
    expect(resolveEffectiveLayout([v], at('2026-02-01T00:00:00Z'))?.version).toBe(1);
    expect(resolveEffectiveLayout([v], at('2026-01-04T00:00:00Z'))).toBeNull();
  });

  it('returns null when every published version is still in the future', () => {
    // Refusing is correct: there is genuinely no layout in effect for that date, and
    // silently reaching for a future one would sell seats from a room that does not exist yet.
    const future = version({ version: 1, effectiveFrom: at('2026-12-01T00:00:00Z') });
    expect(resolveEffectiveLayout([future], at('2026-06-01T00:00:00Z'))).toBeNull();
  });
});

describe('evaluateLayoutOperation', () => {
  it('allows cloning from any state', () => {
    for (const status of ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const) {
      expect(evaluateLayoutOperation(version({ status }), 'CLONE', commitments()).allowed).toBe(
        true,
      );
    }
  });

  it('allows editing only a draft', () => {
    expect(
      evaluateLayoutOperation(version({ status: 'DRAFT' }), 'EDIT', commitments()).allowed,
    ).toBe(true);
    const refused = evaluateLayoutOperation(
      version({ status: 'PUBLISHED' }),
      'EDIT',
      commitments(),
    );
    expect(refused.allowed).toBe(false);
    expect(refused.code).toBe('LAYOUT_NOT_DRAFT');
    // The refusal must say what to do instead, not just say no.
    expect(refused.message).toMatch(/clone/i);
  });

  it('refuses to edit an archived layout', () => {
    expect(
      evaluateLayoutOperation(version({ status: 'ARCHIVED' }), 'EDIT', commitments()).allowed,
    ).toBe(false);
  });

  it('publishes a draft, and refuses to republish', () => {
    expect(
      evaluateLayoutOperation(version({ status: 'DRAFT' }), 'PUBLISH', commitments()).allowed,
    ).toBe(true);
    expect(
      evaluateLayoutOperation(version({ status: 'PUBLISHED' }), 'PUBLISH', commitments()).code,
    ).toBe('LAYOUT_ALREADY_PUBLISHED');
    expect(
      evaluateLayoutOperation(version({ status: 'ARCHIVED' }), 'PUBLISH', commitments()).code,
    ).toBe('LAYOUT_ARCHIVED');
  });

  it('archives a superseded published version', () => {
    expect(
      evaluateLayoutOperation(version(), 'ARCHIVE', commitments({ otherPublishedVersions: 1 }))
        .allowed,
    ).toBe(true);
  });

  it('refuses to archive while future shows still use it', () => {
    const verdict = evaluateLayoutOperation(version(), 'ARCHIVE', commitments({ futureShows: 3 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('LAYOUT_HAS_FUTURE_SHOWS');
    expect(verdict.message).toContain('3 scheduled shows');
  });

  it('gets the singular right when exactly one show is affected', () => {
    expect(
      evaluateLayoutOperation(version(), 'ARCHIVE', commitments({ futureShows: 1 })).message,
    ).toContain('1 scheduled show ');
  });

  it('refuses to archive the last published layout', () => {
    // Otherwise the screen becomes unschedulable and nothing explains why.
    const verdict = evaluateLayoutOperation(
      version(),
      'ARCHIVE',
      commitments({ otherPublishedVersions: 0 }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('LAYOUT_LAST_PUBLISHED');
  });

  it('historical shows do NOT block archiving', () => {
    // They hold their own seat rows. Archiving is a planning decision, not a deletion, so
    // past trading must never stand in the way of retiring a layout.
    expect(
      evaluateLayoutOperation(version(), 'ARCHIVE', commitments({ historicalShows: 500 })).allowed,
    ).toBe(true);
  });

  it('deletes only a draft', () => {
    expect(
      evaluateLayoutOperation(version({ status: 'DRAFT' }), 'DELETE', commitments()).allowed,
    ).toBe(true);
    const refused = evaluateLayoutOperation(version(), 'DELETE', commitments());
    expect(refused.allowed).toBe(false);
    expect(refused.message).toMatch(/archive it instead/i);
  });
});

describe('compareLayouts', () => {
  const seat = (
    row: string,
    label: string,
    categoryName = 'Normal',
    kind = 'SEAT',
  ): ComparableSeat => ({
    row,
    label,
    categoryName,
    kind,
  });

  it('reports nothing changed between identical layouts', () => {
    const seats = [seat('A', '1'), seat('A', '2')];
    const diff = compareLayouts(seats, [...seats]);
    expect(diff.addedSeats).toEqual([]);
    expect(diff.removedSeats).toEqual([]);
    expect(diff.changedSeats).toEqual([]);
    expect(diff.unchangedCount).toBe(2);
    expect(diff.capacityDelta).toBe(0);
  });

  it('matches seats by row+label, not by id', () => {
    // A clone creates entirely new Seat rows. Matching on id would report every seat as
    // removed and re-added, which tells an operator nothing at all.
    const before = [seat('A', '1'), seat('A', '2')];
    const after = [seat('A', '1'), seat('A', '2')];
    expect(compareLayouts(before, after).unchangedCount).toBe(2);
  });

  it('detects an added seat', () => {
    const diff = compareLayouts([seat('A', '1')], [seat('A', '1'), seat('A', '2')]);
    expect(diff.addedSeats.map((s) => s.seat)).toEqual(['A2']);
    expect(diff.capacityDelta).toBe(1);
  });

  it('detects a removed seat', () => {
    const diff = compareLayouts([seat('A', '1'), seat('A', '2')], [seat('A', '1')]);
    expect(diff.removedSeats.map((s) => s.seat)).toEqual(['A2']);
    expect(diff.capacityDelta).toBe(-1);
  });

  it('detects a re-categorised seat and reports both sides', () => {
    // The recliner conversion: same seat, different price tier. An operator needs the
    // before AND after or they cannot tell whether the change is the one they intended.
    const diff = compareLayouts([seat('A', '1', 'Normal')], [seat('A', '1', 'Recliner')]);
    expect(diff.changedSeats).toEqual([
      {
        seat: 'A1',
        from: { categoryName: 'Normal', kind: 'SEAT' },
        to: { categoryName: 'Recliner', kind: 'SEAT' },
      },
    ]);
    // A re-categorisation does not change how many seats there are.
    expect(diff.capacityDelta).toBe(0);
  });

  it('detects a seat converted to a wheelchair space', () => {
    const diff = compareLayouts(
      [seat('A', '1', 'Normal', 'SEAT')],
      [seat('A', '1', 'Normal', 'WHEELCHAIR')],
    );
    expect(diff.changedSeats[0].to).toEqual({ categoryName: 'Normal', kind: 'WHEELCHAIR' });
  });

  it('does not count gaps as capacity', () => {
    // Turning a seat into an aisle loses a sellable seat even though the element count is
    // unchanged. Counting rows rather than sellable seats would report no change.
    const diff = compareLayouts(
      [seat('A', '1'), seat('A', '2')],
      [seat('A', '1'), seat('A', '2', 'Normal', 'GAP')],
    );
    expect(diff.capacityDelta).toBe(-1);
  });

  it('sorts changes so the same diff always reads the same way', () => {
    const diff = compareLayouts([], [seat('B', '2'), seat('A', '1'), seat('A', '2')]);
    expect(diff.addedSeats.map((s) => s.seat)).toEqual(['A1', 'A2', 'B2']);
  });

  it('handles a wholesale re-lettering as removals plus additions', () => {
    const diff = compareLayouts([seat('A', '1')], [seat('AA', '1')]);
    expect(diff.removedSeats.map((s) => s.seat)).toEqual(['A1']);
    expect(diff.addedSeats.map((s) => s.seat)).toEqual(['AA1']);
    expect(diff.capacityDelta).toBe(0);
  });
});

describe('isSellableKind', () => {
  it('treats only gaps as unsellable', () => {
    expect(isSellableKind('SEAT')).toBe(true);
    expect(isSellableKind('GAP')).toBe(false);
  });

  it('wheelchair and companion spaces ARE sellable', () => {
    // Restricting who may book them is a booking rule. Hiding them from inventory would
    // mean a wheelchair user cannot book at all.
    expect(isSellableKind('WHEELCHAIR')).toBe(true);
    expect(isSellableKind('COMPANION')).toBe(true);
  });
});
