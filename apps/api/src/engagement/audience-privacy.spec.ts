import { applyPrivacyThreshold, withRunningTotal } from './audience-privacy';

describe('applyPrivacyThreshold', () => {
  it('hides every bucket under five and says only how many were hidden', () => {
    const out = applyPrivacyThreshold([
      { city: 'Guntur', country: 'India', followers: 4 },
      { city: 'Vijayawada', country: 'India', followers: 5 },
      { city: 'Hyderabad', country: 'India', followers: 12 },
      { city: 'Tenali', country: 'India', followers: 1 },
    ]);
    expect(out.buckets.map((b) => b.city)).toEqual(['Hyderabad', 'Vijayawada']);
    expect(out.hiddenBuckets).toBe(2);
    expect(out.threshold).toBe(5);
    expect(JSON.stringify(out)).not.toMatch(/Guntur|Tenali/);
  });

  it('returns nothing rather than a small group when all are small', () => {
    expect(applyPrivacyThreshold([{ city: 'A', country: null, followers: 2 }]).buckets).toEqual([]);
  });
});

describe('withRunningTotal', () => {
  it("ends at today's total and never goes down", () => {
    const series = withRunningTotal(
      [
        { start: '2026-10-25', newFollowers: 2 },
        { start: '2026-10-26', newFollowers: 0 },
        { start: '2026-10-27', newFollowers: 3 },
      ],
      10,
    );
    expect(series.map((p) => p.followers)).toEqual([7, 7, 10]);
  });
});
