import {
  coverageGaps,
  deletionImpact,
  majorUnitMinor,
  type CoverageBand,
} from './fee-band-coverage';

/**
 * Whether a fee schedule still prices every order once a band is deleted. Pure: the service
 * test and the real-Postgres test cover the wiring.
 */

const band = (
  id: string,
  minMinor: number,
  maxMinor: number | null,
  scope: Partial<Pick<CoverageBand, 'country' | 'region'>> = {},
): CoverageBand & { active: boolean } => ({
  id,
  minMinor,
  maxMinor,
  country: scope.country ?? 'India',
  region: scope.region ?? '*',
  active: true,
});

// The seeded INR schedule: whole-rupee boundaries, so 99 paise sit between bands.
const INR = [
  band('a', 0, 19_900),
  band('b', 20_000, 49_900),
  band('c', 50_000, 99_900),
  band('d', 100_000, null),
];

describe('coverageGaps', () => {
  it('treats whole-unit boundaries as continuous', () => {
    expect(coverageGaps(INR, 'INR')).toEqual([]);
  });

  it('treats cent-adjacent USD bands as continuous', () => {
    expect(coverageGaps([band('a', 0, 999), band('b', 1_000, null)], 'USD')).toEqual([]);
  });

  it('finds a hole wider than one major unit', () => {
    expect(coverageGaps([band('a', 0, 19_900), band('b', 50_000, null)], 'INR')).toEqual([
      { afterMinor: 19_900, beforeMinor: 50_000 },
    ]);
  });

  it('finds a missing bottom and a missing top', () => {
    expect(coverageGaps([band('b', 20_000, 49_900)], 'INR')).toEqual([
      { afterMinor: null, beforeMinor: 20_000 },
      { afterMinor: 49_900, beforeMinor: null },
    ]);
  });

  it('reports everything as uncovered when there are no bands', () => {
    expect(coverageGaps([], 'INR')).toEqual([{ afterMinor: null, beforeMinor: null }]);
  });

  it('knows the major unit of a currency', () => {
    expect(majorUnitMinor('INR')).toBe(100);
    expect(majorUnitMinor('USD')).toBe(100);
    expect(majorUnitMinor('JPY')).toBe(1);
  });
});

describe('deletionImpact', () => {
  it('refuses deleting a middle band and names the hole', () => {
    expect(deletionImpact(INR[2], INR, 'INR')).toEqual({
      ok: false,
      reason: 'GAP',
      gaps: [{ afterMinor: 49_900, beforeMinor: 100_000 }],
    });
  });

  it('refuses deleting the top band (orders above would have no band)', () => {
    expect(deletionImpact(INR[3], INR, 'INR')).toEqual({
      ok: false,
      reason: 'GAP',
      gaps: [{ afterMinor: 99_900, beforeMinor: null }],
    });
  });

  it('refuses deleting the bottom band', () => {
    expect(deletionImpact(INR[0], INR, 'INR')).toMatchObject({
      ok: false,
      gaps: [{ afterMinor: null, beforeMinor: 20_000 }],
    });
  });

  it('refuses deleting the last band (pricing would use the built-in defaults)', () => {
    const only = band('x', 0, null, { country: 'United States' });
    expect(deletionImpact(only, [only], 'USD')).toEqual({ ok: false, reason: 'NO_BAND_LEFT' });
  });

  it('allows deleting an inactive band, whatever is left', () => {
    const off = { ...band('x', 0, null), active: false };
    expect(deletionImpact(off, [], 'INR')).toEqual({ ok: true });
  });

  it('allows deleting a band whose range another band already covers', () => {
    // A state override over the national schedule: the national band covers the range again.
    const state = band('s', 0, 19_900, { region: 'Telangana' });
    expect(deletionImpact(state, [...INR, state], 'INR')).toEqual({ ok: true });
  });

  it('allows deleting a state band when the national schedule still covers the state', () => {
    const s1 = band('s1', 0, 19_900, { region: 'Telangana' });
    const s2 = band('s2', 20_000, 49_900, { region: 'Telangana' });
    expect(deletionImpact(s2, [...INR, s1, s2], 'INR')).toEqual({ ok: true });
  });

  it('refuses deleting the only band for a state that has no national schedule', () => {
    const state = band('s', 0, null, { region: 'Telangana' });
    expect(deletionImpact(state, [state], 'INR')).toEqual({ ok: false, reason: 'NO_BAND_LEFT' });
  });

  it('does not block on a hole that was already there', () => {
    const holey = [band('a', 0, 19_900), band('b', 50_000, 99_900), band('c', 100_000, null)];
    // Deleting `a` leaves 0..50000 open, which is a NEW hole (it reaches 0): refused.
    expect(deletionImpact(holey[0], holey, 'INR')).toMatchObject({ ok: false, reason: 'GAP' });
    // Adding a duplicate-cover band elsewhere and deleting it changes nothing about the old hole.
    const extra = band('e', 120_000, 150_000, { region: 'Kerala' });
    expect(deletionImpact(extra, [...holey, extra], 'INR')).toEqual({ ok: true });
  });

  it('ignores bands in other countries', () => {
    const us = band('u', 0, null, { country: 'United States' });
    expect(deletionImpact(INR[3], [...INR, us], 'INR')).toMatchObject({ ok: false });
  });
});
