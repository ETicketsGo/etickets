import { describe, expect, it } from 'vitest';
import type {
  EventSellability,
  OrganizerAction,
  OrganizerSessionSaleEligibility,
  SellabilityIssue,
} from '@eticketsgo/web-kit';
import { eventSelling, lifecycleLabel, sessionSelling, setupSummary } from './status';

/**
 * The status words on the Overview. The defects these exist for: "Ready to sell" on a DRAFT
 * event, which nobody could buy because a draft is not on the storefront; and "Selling" on a
 * Telangana cinema show that checkout refused with SALE_NOT_OPEN, because only the
 * configuration check had been asked and not checkout's own sale-eligibility rules.
 */

const clean: EventSellability = {
  eventId: 'e1',
  sellable: true,
  blockers: [],
  warnings: [],
  checkedAt: '2026-10-09T00:00:00Z',
};

const eligible: OrganizerSessionSaleEligibility = {
  sessionId: 's1',
  open: true,
  sellable: true,
  blockers: [],
};

/** What the server says for a Telangana cinema show with no state price rules (as on QA). */
const telangana: OrganizerSessionSaleEligibility = {
  sessionId: 's1',
  open: false,
  sellable: false,
  blockers: [
    {
      code: 'NO_PRICING_POLICY',
      owner: 'PLATFORM',
      message:
        'Ticket sales are paused for cinemas in Telangana: no state price rules are configured yet. Contact support.',
      fixPath: null,
    },
  ],
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

const now = new Date('2026-10-10T10:00:00Z');
const show = {
  sessionStatus: 'SCHEDULED',
  startsAt: '2026-10-11T13:30:00Z',
  sold: 10,
  capacity: 100,
  sessionId: 's1',
  sellability: clean,
  eligibility: eligible,
  now,
};

describe('an event is only ever "Selling" when it is published and the server agrees', () => {
  it('never says a draft is selling, even with both checks clean', () => {
    // THE regression. The configuration is complete; the event is still not on sale.
    const s = eventSelling('DRAFT', show, 60);
    expect(s.selling).toBe(false);
    expect(s.label).toBe('Not selling: draft, not submitted');
    expect(s.label).not.toMatch(/ready to sell/i);
  });

  it.each(ALL_STATUSES.filter((st) => st !== 'PUBLISHED'))('never says %s is selling', (status) => {
    expect(eventSelling(status, show, 60).selling).toBe(false);
    expect(eventSelling(status, show, 60).label.startsWith('Not selling: ')).toBe(true);
  });

  it('says a published event whose next show checkout would sell is selling', () => {
    expect(eventSelling('PUBLISHED', show, 60)).toEqual({ selling: true, label: 'Selling' });
  });

  it('says "Checking" - not "Selling" - before the shows have loaded', () => {
    expect(eventSelling('PUBLISHED', undefined, 60)).toEqual({
      selling: null,
      label: 'Checking sales',
    });
  });

  it('says nothing about selling for an event with no show in the window', () => {
    expect(eventSelling('PUBLISHED', null, 60)).toEqual({
      selling: null,
      label: 'No shows in the next 60 days',
    });
  });

  it('never says a Telangana show checkout refuses is selling, and keeps the server reason', () => {
    const s = eventSelling('PUBLISHED', { ...show, eligibility: telangana }, 60);
    expect(s.selling).toBe(false);
    expect(s.label).toBe('Not selling: no state price rules yet');
    expect(s.detail).toBe(telangana.blockers[0].message);
  });
});

describe('sale eligibility is required for "Selling"', () => {
  it.each([
    'NO_PRICING_POLICY',
    'PRICING_POLICY_CONFLICT',
    'CINEMA_NOT_CLASSIFIED',
    'SEAT_CLASS_UNMAPPED',
    'PRICE_OVER_CEILING',
    'REGULATORY_PRICING_UNRESOLVED',
    'SOMETHING_NEW',
  ])('eligible=false (%s) is never Selling', (code) => {
    const s = sessionSelling({
      ...show,
      eventStatus: 'PUBLISHED',
      eligibility: { ...telangana, blockers: [{ ...telangana.blockers[0], code }] },
    });
    expect(s.selling).toBe(false);
    expect(s.label.startsWith('Not selling: ')).toBe(true);
  });

  it('a refusal with no blocker listed is still never Selling', () => {
    const s = sessionSelling({
      ...show,
      eventStatus: 'PUBLISHED',
      eligibility: { ...telangana, blockers: [] },
    });
    expect(s).toEqual({ selling: false, label: 'Not selling: checkout would refuse it' });
  });

  it('is "Checking" while eligibility has not answered, even with a clean configuration', () => {
    const s = sessionSelling({ ...show, eventStatus: 'PUBLISHED', eligibility: undefined });
    expect(s.label).toBe('Checking sales');
  });

  it('a show where some ticket types sell is open, as the storefront treats it', () => {
    const partly = { ...telangana, open: true };
    const s = sessionSelling({ ...show, eventStatus: 'PUBLISHED', eligibility: partly });
    expect(s.selling).toBe(true);
  });
});

describe('a show', () => {
  const base = { ...show, eventStatus: 'PUBLISHED' };

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

  it('is held back by a configuration blocker naming it, not by one naming another show', () => {
    const other = blocker({ sessions: [{ id: 's2', startsAt: base.startsAt, timeZone: null }] });
    const mine = blocker({ sessions: [{ id: 's1', startsAt: base.startsAt, timeZone: null }] });
    const withOther = { ...clean, sellable: false, blockers: [other] };
    const withMine = { ...clean, sellable: false, blockers: [mine] };
    expect(sessionSelling({ ...base, sellability: withOther }).selling).toBe(true);
    expect(sessionSelling({ ...base, sellability: withMine }).label).toBe(
      'Not selling: 1 problem to fix',
    );
  });

  it('is held back by a fault that belongs to no one show', () => {
    const eventWide = blocker({ code: 'NO_SESSIONS', sessions: [] });
    const sellability = { ...clean, sellable: false, blockers: [eventWide] };
    expect(sessionSelling({ ...base, sellability }).selling).toBe(false);
  });

  it('a warning is not a reason not to sell', () => {
    const sellability = { ...clean, warnings: [blocker()] };
    expect(sessionSelling({ ...base, sellability }).selling).toBe(true);
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
