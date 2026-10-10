import { describe, expect, it } from 'vitest';
import type { OrganizerAction } from '@eticketsgo/web-kit';
import type { EventSaleState, SaleReason } from '@eticketsgo/shared-types';
import { lifecycleLabel, sellingOf, sellingTone, setupSummary } from './status';

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

const reason = (over: Partial<SaleReason> = {}): SaleReason => ({
  code: 'SEAT_CLASS_UNMAPPED',
  text: 'seat classes not mapped',
  message: 'Seat category Standard needs a regulatory seat class before tickets can be sold.',
  owner: 'ORGANIZER',
  fixPath: '/organizer/cinemas/c1/readiness#seat-classes',
  ticketTypeIds: ['standard'],
  affectedSessions: 1,
  ...over,
});

const answer = (
  state: EventSaleState['state'],
  reasons: SaleReason[] = [],
): Pick<EventSaleState, 'state' | 'reasons'> => ({ state, reasons });

/**
 * The Overview renders the server's unified sale state and nothing else. These pin the words:
 * the QA defect was the Overview saying "Not selling: 1 problem to fix" about a show the cinema
 * drawer called "Selling" while checkout sold its mapped seats. Partial is never "Selling".
 */
describe('the Overview puts the server answer into words', () => {
  it('says Selling only for SELLING', () => {
    const s = sellingOf(answer('SELLING'));
    expect(s.label).toBe('Selling');
    expect(s.detail).toBeUndefined();
    expect(sellingTone(s)).toBe('success');
  });

  it('never says bare Selling for a PARTIAL show or event', () => {
    const s = sellingOf(answer('PARTIAL', [reason()]));
    expect(s.label).toBe('Partly selling: seat classes not mapped');
    expect(s.label).not.toBe('Selling');
    expect(s.detail).toBe(reason().message);
    expect(sellingTone(s)).toBe('info');
  });

  it('says Not selling with the reason, and keeps the full sentence', () => {
    const telangana = reason({
      code: 'NO_PRICING_POLICY',
      text: 'Telangana pricing rules not configured',
      message: 'Ticket sales are paused for cinemas in Telangana.',
      owner: 'PLATFORM',
      fixPath: null,
    });
    const s = sellingOf(answer('NOT_SELLING', [telangana]));
    expect(s.label).toBe('Not selling: Telangana pricing rules not configured');
    expect(s.detail).toBe('Ticket sales are paused for cinemas in Telangana.');
    expect(sellingTone(s)).toBe('warning');
  });

  it('a draft reads as the server words it', () => {
    const s = sellingOf(
      answer('NOT_SELLING', [
        reason({ code: 'EVENT_NOT_PUBLISHED', text: 'draft, not submitted' }),
      ]),
    );
    expect(s.label).toBe('Not selling: draft, not submitted');
    // Where it is in its life, not a fault: no amber.
    expect(sellingTone(s)).toBe('neutral');
  });

  it('says checking, or unavailable, while there is no answer - never Selling', () => {
    expect(sellingOf(undefined)).toEqual({ state: null, label: 'Checking sales', tone: 'neutral' });
    expect(sellingOf(undefined, true)).toEqual({
      state: null,
      label: 'Sales status unavailable',
      tone: 'neutral',
    });
    expect(sellingTone(sellingOf(undefined))).toBe('neutral');
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
