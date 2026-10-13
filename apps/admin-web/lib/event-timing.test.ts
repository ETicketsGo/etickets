import { describe, expect, it } from 'vitest';
import { alreadyHappened } from './event-timing';

const NOW = new Date('2026-10-12T10:00:00Z');
const base = {
  status: 'UNDER_REVIEW',
  sessionCount: 1,
  firstSessionAt: '2026-09-18T01:31:32.819Z',
  lastSessionAt: '2026-09-18T01:31:32.819Z',
};

describe('alreadyHappened', () => {
  it('flags a submission whose only show is over', () => {
    expect(alreadyHappened(base, NOW)).toBe(true);
  });

  it('does not flag a run that has started but not ended', () => {
    expect(
      alreadyHappened({ ...base, sessionCount: 3, lastSessionAt: '2026-11-01T00:00:00Z' }, NOW),
    ).toBe(false);
  });

  it('does not flag a future show, an event with no dates, or one not waiting for review', () => {
    expect(
      alreadyHappened(
        { ...base, firstSessionAt: '2026-11-23T02:00:00Z', lastSessionAt: '2026-11-23T02:00:00Z' },
        NOW,
      ),
    ).toBe(false);
    expect(
      alreadyHappened({ ...base, sessionCount: 0, firstSessionAt: null, lastSessionAt: null }, NOW),
    ).toBe(false);
    expect(alreadyHappened({ ...base, status: 'PUBLISHED' }, NOW)).toBe(false);
  });
});
