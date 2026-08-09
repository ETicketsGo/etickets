import {
  DEFAULT_TURNAROUND_MINUTES,
  datesInRange,
  decideSchedule,
  expandSchedule,
  gapMinutesBetween,
  windowsConflict,
  type ProposedShow,
  type ShowWindow,
} from './show-scheduling';

/**
 * Screen double-booking is the failure these rules exist to prevent. Before this,
 * `scheduleShow` validated tenant ownership, cinema→screen ownership and seat-map presence,
 * and then created the session with no overlap check at all — two films could be sold into
 * the same room at the same time, and nobody would find out until the door.
 */

const at = (iso: string) => new Date(iso);
const win = (start: string, end: string, id?: string): ShowWindow => ({
  id,
  startsAt: at(start),
  endsAt: at(end),
});
const proposal = (start: string, end: string, index = 0): ProposedShow => ({
  index,
  startsAt: at(start),
  endsAt: at(end),
});

const NOW = at('2026-08-10T00:00:00Z');
const decide = (proposed: ProposedShow[], existing: ShowWindow[] = [], turnaround = 15) =>
  decideSchedule({ proposed, existing, turnaroundMinutes: turnaround, now: NOW });

describe('windowsConflict', () => {
  it('detects a straightforward overlap', () => {
    expect(
      windowsConflict(
        win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z'),
        win('2026-08-11T15:00:00Z', '2026-08-11T17:00:00Z'),
        0,
      ),
    ).toBe(true);
  });

  it('detects containment in both directions', () => {
    const outer = win('2026-08-11T10:00:00Z', '2026-08-11T20:00:00Z');
    const inner = win('2026-08-11T12:00:00Z', '2026-08-11T13:00:00Z');
    expect(windowsConflict(outer, inner, 0)).toBe(true);
    expect(windowsConflict(inner, outer, 0)).toBe(true);
  });

  it('is symmetric', () => {
    const a = win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z');
    const b = win('2026-08-11T15:30:00Z', '2026-08-11T17:00:00Z');
    expect(windowsConflict(a, b, 15)).toBe(windowsConflict(b, a, 15));
  });

  it('rejects exactly back-to-back shows once a turnaround is required', () => {
    // 16:00 → 16:00 reads fine in a spreadsheet and cannot be run: the room still has an
    // audience in it.
    const first = win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z');
    const second = win('2026-08-11T16:00:00Z', '2026-08-11T18:00:00Z');
    expect(windowsConflict(first, second, 15)).toBe(true);
    expect(windowsConflict(first, second, 0)).toBe(false);
  });

  it('accepts a gap exactly equal to the turnaround', () => {
    const first = win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z');
    const second = win('2026-08-11T16:15:00Z', '2026-08-11T18:00:00Z');
    expect(windowsConflict(first, second, 15)).toBe(false);
  });

  it('rejects one minute short of the turnaround', () => {
    const first = win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z');
    const second = win('2026-08-11T16:14:00Z', '2026-08-11T18:00:00Z');
    expect(windowsConflict(first, second, 15)).toBe(true);
  });

  it('applies the turnaround once to the pair, not once per show', () => {
    // An operator who configures 15 minutes means 15 between shows. Adding the gap to each
    // window's end would quietly demand 30 and reject a legal schedule.
    const first = win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z');
    const second = win('2026-08-11T16:20:00Z', '2026-08-11T18:00:00Z');
    expect(windowsConflict(first, second, 15)).toBe(false);
  });

  it('treats a negative turnaround as zero rather than inverting the rule', () => {
    const first = win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z');
    const second = win('2026-08-11T16:00:00Z', '2026-08-11T18:00:00Z');
    expect(windowsConflict(first, second, -60)).toBe(false);
  });
});

describe('gapMinutesBetween', () => {
  it('reports the gap regardless of argument order', () => {
    const a = win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z');
    const b = win('2026-08-11T16:30:00Z', '2026-08-11T18:00:00Z');
    expect(gapMinutesBetween(a, b)).toBe(30);
    expect(gapMinutesBetween(b, a)).toBe(30);
  });

  it('goes negative for a true overlap, which is what makes it readable in a conflict', () => {
    expect(
      gapMinutesBetween(
        win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z'),
        win('2026-08-11T15:00:00Z', '2026-08-11T17:00:00Z'),
      ),
    ).toBe(-60);
  });
});

describe('decideSchedule', () => {
  it('accepts a clean daily grid', () => {
    const result = decide([
      proposal('2026-08-11T04:00:00Z', '2026-08-11T06:18:00Z', 0),
      proposal('2026-08-11T07:15:00Z', '2026-08-11T09:33:00Z', 1),
      proposal('2026-08-11T11:00:00Z', '2026-08-11T13:18:00Z', 2),
    ]);
    expect(result.creatable).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
  });

  it('rejects a show that overlaps one already on the screen, naming it', () => {
    const result = decide(
      [proposal('2026-08-11T15:00:00Z', '2026-08-11T17:00:00Z')],
      [win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z', 'session-existing')],
    );
    expect(result.creatable).toHaveLength(0);
    expect(result.rejected[0].rejection).toEqual({
      reason: 'OVERLAPS_EXISTING_SHOW',
      conflictsWith: 'session-existing',
      gapMinutes: -60,
    });
  });

  /**
   * The bulk-specific failure. Every proposal here is individually legal against the
   * database; they collide only with each other. Checking each against existing shows alone
   * — the obvious implementation — passes all three and double-books the screen twice.
   */
  it('checks proposals against each other, not just against the database', () => {
    const result = decide([
      proposal('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z', 0),
      proposal('2026-08-11T15:00:00Z', '2026-08-11T17:00:00Z', 1),
      proposal('2026-08-11T15:30:00Z', '2026-08-11T17:30:00Z', 2),
    ]);
    expect(result.creatable.map((c) => c.index)).toEqual([0]);
    expect(result.rejected).toHaveLength(2);
    for (const r of result.rejected) {
      expect(r.rejection.reason).toBe('OVERLAPS_PROPOSED_SHOW');
    }
  });

  it('reports an exact repeat as a duplicate rather than an overlap', () => {
    const result = decide([
      proposal('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z', 0),
      proposal('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z', 1),
    ]);
    expect(result.creatable.map((c) => c.index)).toEqual([0]);
    expect(result.rejected[0].rejection).toEqual({
      reason: 'DUPLICATE_IN_REQUEST',
      duplicateOf: 0,
    });
  });

  it('skips past slots without failing the rest of the batch', () => {
    // A range that starts "today" routinely produces a few of these.
    const result = decide([
      proposal('2026-08-09T10:00:00Z', '2026-08-09T12:00:00Z', 0),
      proposal('2026-08-12T10:00:00Z', '2026-08-12T12:00:00Z', 1),
    ]);
    expect(result.rejected[0].rejection.reason).toBe('IN_THE_PAST');
    expect(result.creatable.map((c) => c.index)).toEqual([1]);
  });

  it('rejects a window that ends before it starts', () => {
    const result = decide([proposal('2026-08-11T16:00:00Z', '2026-08-11T14:00:00Z')]);
    expect(result.rejected[0].rejection.reason).toBe('ENDS_BEFORE_IT_STARTS');
  });

  it('rejects a zero-length window', () => {
    const result = decide([proposal('2026-08-11T16:00:00Z', '2026-08-11T16:00:00Z')]);
    expect(result.rejected[0].rejection.reason).toBe('ENDS_BEFORE_IT_STARTS');
  });

  it('never both creates and rejects the same proposal', () => {
    const result = decide(
      [
        proposal('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z', 0),
        proposal('2026-08-11T15:00:00Z', '2026-08-11T17:00:00Z', 1),
        proposal('2026-08-09T09:00:00Z', '2026-08-09T11:00:00Z', 2),
      ],
      [win('2026-08-11T20:00:00Z', '2026-08-11T22:00:00Z', 'later')],
    );
    const created = new Set(result.creatable.map((c) => c.index));
    const refused = new Set(result.rejected.map((r) => r.show.index));
    for (const i of created) expect(refused.has(i)).toBe(false);
    expect(created.size + refused.size).toBe(result.proposed.length);
  });

  it('reports every decision rather than stopping at the first problem', () => {
    // An operator fixing a day's grid should see the whole picture in one pass.
    const result = decide([
      proposal('2026-08-11T14:00:00Z', '2026-08-11T13:00:00Z', 0),
      proposal('2026-08-09T14:00:00Z', '2026-08-09T16:00:00Z', 1),
      proposal('2026-08-11T18:00:00Z', '2026-08-11T20:00:00Z', 2),
      proposal('2026-08-11T18:00:00Z', '2026-08-11T20:00:00Z', 3),
    ]);
    expect(result.rejected.map((r) => r.rejection.reason)).toEqual([
      'ENDS_BEFORE_IT_STARTS',
      'IN_THE_PAST',
      'DUPLICATE_IN_REQUEST',
    ]);
    expect(result.creatable.map((c) => c.index)).toEqual([2]);
  });

  it('ignores an existing show far enough away', () => {
    const result = decide(
      [proposal('2026-08-11T18:00:00Z', '2026-08-11T20:00:00Z')],
      [win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z', 'earlier')],
    );
    expect(result.creatable).toHaveLength(1);
  });

  it('uses the configured turnaround, so a tighter house can pack its day', () => {
    const back2back = [proposal('2026-08-11T16:00:00Z', '2026-08-11T18:00:00Z')];
    const existing = [win('2026-08-11T14:00:00Z', '2026-08-11T16:00:00Z', 'prev')];
    expect(decide(back2back, existing, 15).creatable).toHaveLength(0);
    expect(decide(back2back, existing, 0).creatable).toHaveLength(1);
  });
});

describe('expandSchedule', () => {
  // Wall-clock times applied per date, as a theater publishes them. UTC here keeps the test
  // about expansion rather than about offsets.
  const toInstant = (date: string, time: string) => new Date(`${date}T${time}:00Z`);

  it('produces one show per date-time pair', () => {
    const shows = expandSchedule({
      dates: ['2026-08-21', '2026-08-22'],
      times: ['09:00', '12:45', '16:30'],
      runtimeMinutes: 138,
      toInstant,
    });
    expect(shows).toHaveLength(6);
    expect(shows.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('derives the end time from the runtime', () => {
    const [show] = expandSchedule({
      dates: ['2026-08-21'],
      times: ['09:00'],
      runtimeMinutes: 138,
      toInstant,
    });
    expect(show.endsAt.toISOString()).toBe('2026-08-21T11:18:00.000Z');
  });

  it('keeps the same wall-clock time on every date', () => {
    const shows = expandSchedule({
      dates: ['2026-08-21', '2026-08-22'],
      times: ['20:15'],
      runtimeMinutes: 100,
      toInstant,
    });
    expect(shows.map((s) => s.startsAt.toISOString().slice(11, 16))).toEqual(['20:15', '20:15']);
  });

  it('orders dates outer and times inner, matching a printed schedule', () => {
    const shows = expandSchedule({
      dates: ['2026-08-21', '2026-08-22'],
      times: ['09:00', '23:45'],
      runtimeMinutes: 60,
      toInstant,
    });
    expect(shows.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-08-21T09:00:00.000Z',
      '2026-08-21T23:45:00.000Z',
      '2026-08-22T09:00:00.000Z',
      '2026-08-22T23:45:00.000Z',
    ]);
  });

  it('returns nothing when either axis is empty', () => {
    expect(expandSchedule({ dates: [], times: ['09:00'], runtimeMinutes: 90, toInstant })).toEqual(
      [],
    );
    expect(
      expandSchedule({ dates: ['2026-08-21'], times: [], runtimeMinutes: 90, toInstant }),
    ).toEqual([]);
  });
});

describe('datesInRange', () => {
  it('is inclusive of both ends', () => {
    expect(datesInRange('2026-08-21', '2026-08-24')).toEqual([
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
      '2026-08-24',
    ]);
  });

  it('returns the single day when from equals to', () => {
    expect(datesInRange('2026-08-21', '2026-08-21')).toEqual(['2026-08-21']);
  });

  it('returns nothing when the range is backwards', () => {
    expect(datesInRange('2026-08-24', '2026-08-21')).toEqual([]);
  });

  it('returns nothing for an unparseable date rather than looping forever', () => {
    expect(datesInRange('not-a-date', '2026-08-21')).toEqual([]);
  });

  it('crosses a month boundary', () => {
    expect(datesInRange('2026-08-30', '2026-09-01')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
    ]);
  });

  it('does not drop or repeat a day across a DST transition', () => {
    // Stepping a LOCAL calendar through late March in Europe produces 23- and 25-hour days
    // and loses one. These are date labels, so the walk is on a UTC calendar.
    const days = datesInRange('2026-03-28', '2026-03-31');
    expect(days).toEqual(['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31']);
    expect(new Set(days).size).toBe(days.length);
  });

  it('spans a full week for the range in the brief', () => {
    expect(datesInRange('2026-08-21', '2026-08-28')).toHaveLength(8);
  });
});

describe('DEFAULT_TURNAROUND_MINUTES', () => {
  it('is a plausible cinema turnaround', () => {
    expect(DEFAULT_TURNAROUND_MINUTES).toBeGreaterThan(0);
    expect(DEFAULT_TURNAROUND_MINUTES).toBeLessThanOrEqual(60);
  });
});
