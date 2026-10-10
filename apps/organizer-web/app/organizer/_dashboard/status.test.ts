import { describe, expect, it } from 'vitest';
import type { EventSellability, OrganizerAction, SellabilityIssue } from '@eticketsgo/web-kit';
import { eventSelling, lifecycleLabel, sessionSelling, setupSummary } from './status';

/**
 * The status words on the Overview. The defect these exist for: "Ready to sell" on a DRAFT
 * event, which nobody could buy because a draft is not on the storefront.
 */

const clean: EventSellability = {
  eventId: 'e1',
  sellable: true,
  blockers: [],
  warnings: [],
  checkedAt: '2026-10-09T00:00:00Z',
};

function blocker(over: Partial<SellabilityIssue> = {}): SellabilityIssue {
  return {
    code: 'UNMAPPED_SEAT_CLASS',
    owner: 'ORGANIZER',
    message: 'A seat category has no regulatory class.',
    fix: 'Map it.',
    fixPath: null,
    affectedSessions: 1,
    ...over,
  };
}

const ALL_STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'PUBLISHED',
  'PAUSED',
  'SOLD_OUT',
  'CANCELLED',
  'COMPLETED',
  'ARCHIVED',
];

describe('an event is only ever "Selling" when it is published and the server agrees', () => {
  it('never says a draft is selling, even with a clean sale check', () => {
    // THE regression. The configuration is complete; the event is still not on sale.
    const s = eventSelling('DRAFT', clean);
    expect(s.selling).toBe(false);
    expect(s.label).toBe('Not selling: draft, not submitted');
    expect(s.label).not.toMatch(/ready to sell/i);
  });

  it.each(ALL_STATUSES.filter((st) => st !== 'PUBLISHED'))('never says %s is selling', (status) => {
    expect(eventSelling(status, clean).selling).toBe(false);
    expect(eventSelling(status, clean).label.startsWith('Not selling: ')).toBe(true);
  });

  it('says a published event with nothing in the way is selling', () => {
    expect(eventSelling('PUBLISHED', clean)).toEqual({ selling: true, label: 'Selling' });
  });

  it('says "Checking" - not "Selling" - before the sale check has answered', () => {
    expect(eventSelling('PUBLISHED', undefined)).toEqual({
      selling: null,
      label: 'Checking sales',
    });
  });

  it('says a published event the checkout would refuse is not selling, and how much is wrong', () => {
    const s = eventSelling('PUBLISHED', {
      ...clean,
      sellable: false,
      blockers: [blocker(), blocker()],
    });
    expect(s).toEqual({ selling: false, label: 'Not selling: 2 problems to fix' });
  });

  it('a warning is not a reason not to sell', () => {
    const s = eventSelling('PUBLISHED', { ...clean, warnings: [blocker()] });
    expect(s.selling).toBe(true);
  });
});

describe('a show', () => {
  const now = new Date('2026-10-10T10:00:00Z');
  const base = {
    eventStatus: 'PUBLISHED',
    sessionStatus: 'SCHEDULED',
    startsAt: '2026-10-11T13:30:00Z',
    sold: 10,
    capacity: 100,
    sessionId: 's1',
    sellability: clean,
    now,
  };

  it('is selling when its event is, and it is scheduled, in the future and not full', () => {
    expect(sessionSelling(base)).toEqual({ selling: true, label: 'Selling' });
  });

  it('of a draft event is not selling', () => {
    expect(sessionSelling({ ...base, eventStatus: 'DRAFT' }).label).toBe(
      'Not selling: draft, not submitted',
    );
  });

  it('that has started is not selling: sales close at the start', () => {
    expect(sessionSelling({ ...base, startsAt: '2026-10-10T09:00:00Z' }).label).toBe(
      'Not selling: show has started',
    );
  });

  it('that is full is not selling', () => {
    expect(sessionSelling({ ...base, sold: 100 }).label).toBe('Not selling: sold out');
  });

  it('that is cancelled or paused is not selling', () => {
    expect(sessionSelling({ ...base, sessionStatus: 'CANCELLED' }).selling).toBe(false);
    expect(sessionSelling({ ...base, sessionStatus: 'PAUSED' }).selling).toBe(false);
  });

  it('is held back by a blocker that names it, and not by one naming another show', () => {
    const other = blocker({ sessions: [{ id: 's2', startsAt: base.startsAt, timeZone: null }] });
    const mine = blocker({ sessions: [{ id: 's1', startsAt: base.startsAt, timeZone: null }] });
    expect(
      sessionSelling({ ...base, sellability: { ...clean, sellable: false, blockers: [other] } })
        .selling,
    ).toBe(true);
    expect(
      sessionSelling({ ...base, sellability: { ...clean, sellable: false, blockers: [mine] } })
        .label,
    ).toBe('Not selling: 1 problem to fix');
  });

  it('is held back by a fault that belongs to no one show', () => {
    const eventWide = blocker({ code: 'NO_SESSIONS', sessions: [] });
    expect(
      sessionSelling({ ...base, sellability: { ...clean, sellable: false, blockers: [eventWide] } })
        .selling,
    ).toBe(false);
  });
});

describe('lifecycle words', () => {
  it('uses the console vocabulary', () => {
    expect(ALL_STATUSES.map(lifecycleLabel)).toEqual([
      'Draft',
      'In review',
      'Published',
      'Paused',
      'Published',
      'Cancelled',
      'Ended',
      'Archived',
    ]);
  });
});

describe('setup', () => {
  const action = (over: Partial<OrganizerAction>): OrganizerAction => ({
    key: over.key ?? 'k',
    category: 'BUSINESS',
    severity: 'SUGGESTED',
    scope: 'ORGANIZATION',
    organizationId: 'o1',
    blocking: false,
    title: 't',
    consequence: 'c',
    fixPath: '/organizer/settings',
    actionLabel: 'Fix',
    done: false,
    ...over,
  });

  it('keeps a blocker out of the folded list, and counts it', () => {
    const s = setupSummary([
      action({ key: 'bank', category: 'MONEY', severity: 'BLOCKING', blocking: true }),
      action({ key: 'legal', severity: 'IMPORTANT' }),
      action({ key: 'photo' }),
      action({ key: 'seatmap', category: 'OPERATIONS', optional: true }),
      action({ key: 'venue', category: 'OPERATIONS', done: true }),
    ]);
    expect(s.blockers.map((a) => a.key)).toEqual(['bank']);
    expect(s.todo.map((a) => a.key)).toEqual(['legal', 'photo', 'seatmap']);
    // Optional steps are listed and never counted.
    expect(s.open).toBe(3);
    expect(s.label).toBe('3 things to set up');
  });

  it('says setup is complete when only optional steps are left', () => {
    expect(setupSummary([action({ optional: true })]).label).toBe('Setup complete');
    expect(setupSummary(undefined).label).toBe('Setup complete');
  });
});
