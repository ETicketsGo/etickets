import { describe, expect, it } from 'vitest';
import {
  hasSessionToday,
  lifecycleOf,
  nextStepOf,
  saleStateOf,
  setupOf,
  type SaleState,
} from './event-lifecycle';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const HOUR = 3_600_000;
const SELLABLE = { sellable: true, blockers: [] };

describe('lifecycleOf: the console vocabulary', () => {
  it.each([
    ['DRAFT', 'Draft'],
    ['UNDER_REVIEW', 'In review'],
    ['PUBLISHED', 'Published'],
    ['SOLD_OUT', 'Published'],
    ['PAUSED', 'Approved'],
    ['COMPLETED', 'Ended'],
    ['CANCELLED', 'Cancelled'],
  ])('%s reads as %s', (status, label) => {
    expect(lifecycleOf({ status }).label).toBe(label);
  });

  it('says a rejected draft has changes requested, and an edited draft does not', () => {
    expect(lifecycleOf({ status: 'DRAFT', reviewNote: 'Fix the poster' }).detail?.label).toBe(
      'Changes requested',
    );
    expect(lifecycleOf({ status: 'DRAFT' }).detail).toBeNull();
  });

  it('names who paused it, because that decides who can lift it', () => {
    expect(lifecycleOf({ status: 'PAUSED', pausedByAdmin: true }).detail?.label).toBe(
      'Paused by platform',
    );
    expect(lifecycleOf({ status: 'PAUSED' }).detail?.label).toBe('Paused');
    expect(lifecycleOf({ status: 'SOLD_OUT' }).detail?.label).toBe('Sold out');
  });
});

describe('saleStateOf: Selling only when the server says so', () => {
  const base = { upcomingSessions: 2, check: SELLABLE };

  it('never says Selling for a draft, however well it is set up', () => {
    // The owner's complaint: "Ready to sell" on a DRAFT event.
    expect(saleStateOf({ ...base, status: 'DRAFT' })).toEqual({
      selling: false,
      label: 'Not selling: not published yet',
    });
    expect(saleStateOf({ ...base, status: 'UNDER_REVIEW' }).label).toBe(
      'Not selling: waiting for approval',
    );
  });

  it('is Selling for a published event the sale check passes', () => {
    expect(saleStateOf({ ...base, status: 'PUBLISHED' })).toEqual({
      selling: true,
      label: 'Selling',
    });
  });

  it('gives the server blocker as the reason, in its own words', () => {
    const state = saleStateOf({
      ...base,
      status: 'PUBLISHED',
      check: {
        sellable: false,
        blockers: [{ message: 'This show has no ticket types.', owner: 'ORGANIZER' }],
      },
    });
    expect(state).toEqual({
      selling: false,
      label: 'Not selling: this show has no ticket types',
    });
  });

  it('does not guess while the check is pending or failed', () => {
    expect(saleStateOf({ status: 'PUBLISHED', upcomingSessions: 1, check: undefined })).toEqual({
      selling: null,
      label: 'Checking sales',
    });
    expect(
      saleStateOf({ status: 'PUBLISHED', upcomingSessions: 1, check: undefined, checkFailed: true })
        .selling,
    ).toBeNull();
  });

  it('is not selling with nothing to come, paused, sold out or ended', () => {
    expect(saleStateOf({ ...base, status: 'PUBLISHED', upcomingSessions: 0 }).label).toBe(
      'Not selling: no sessions to come',
    );
    expect(saleStateOf({ ...base, status: 'PAUSED', pausedByAdmin: true }).label).toBe(
      'Not selling: paused by the platform team',
    );
    expect(saleStateOf({ ...base, status: 'SOLD_OUT' }).label).toBe('Not selling: sold out');
    expect(saleStateOf({ ...base, status: 'COMPLETED' }).label).toBe(
      'Not selling: the event has ended',
    );
  });
});

describe('setupOf', () => {
  it('counts the organizer issues once each, plus the description and picture', () => {
    const setup = setupOf({
      eventId: 'e1',
      description: '',
      hasImage: false,
      issues: [
        { message: 'No ticket types.', owner: 'ORGANIZER', fixPath: '/t' },
        { message: 'No ticket types.', owner: 'ORGANIZER', fixPath: '/t' },
        { message: 'State rules missing.', owner: 'PLATFORM', fixPath: null },
      ],
    });
    expect(setup.label).toBe('3 things to set up');
    expect(setup.items.map((i) => i.label)).toEqual([
      'No ticket types',
      'Add a description',
      'Add a cover picture',
    ]);
  });

  it('says Setup complete when nothing is left', () => {
    expect(setupOf({ eventId: 'e1', description: 'Hi', hasImage: true, issues: [] }).label).toBe(
      'Setup complete',
    );
  });
});

describe('hasSessionToday', () => {
  const venue = { timezone: 'Asia/Kolkata', country: 'IN' };
  it('is today in the VENUE calendar, not the browser one', () => {
    // 12:00Z is 17:30 in Kolkata; 20:00Z is 01:30 the next day there.
    const later = {
      startsAt: new Date(NOW + 3 * HOUR).toISOString(),
      endsAt: new Date(NOW + 5 * HOUR).toISOString(),
      status: 'SCHEDULED',
    };
    const tomorrow = {
      startsAt: new Date(NOW + 8 * HOUR).toISOString(),
      endsAt: new Date(NOW + 10 * HOUR).toISOString(),
      status: 'SCHEDULED',
    };
    expect(hasSessionToday([later], venue, NOW)).toBe(true);
    expect(hasSessionToday([tomorrow], venue, NOW)).toBe(false);
    expect(hasSessionToday([{ ...later, status: 'CANCELLED' }], venue, NOW)).toBe(false);
  });
});

describe('nextStepOf: one thing to do next', () => {
  const selling: SaleState = { selling: true, label: 'Selling' };
  const base = { eventId: 'e1', sessionToday: false, sale: selling, ownBlockers: 0 };

  it('submits a clean draft, and fixes a broken one first', () => {
    expect(nextStepOf({ ...base, status: 'DRAFT' }).kind).toBe('submit');
    const fix = nextStepOf({ ...base, status: 'DRAFT', ownBlockers: 2 });
    expect(fix).toMatchObject({ kind: 'link', href: '#readiness' });
    expect(fix.title).toBe('Fix 2 things before you submit');
  });

  it('opens check-in when doors open today', () => {
    expect(nextStepOf({ ...base, status: 'PUBLISHED', sessionToday: true })).toMatchObject({
      label: 'Open check-in',
      href: '/organizer/events/e1/checkin',
    });
  });

  it('offers no action the organizer cannot take', () => {
    expect(nextStepOf({ ...base, status: 'UNDER_REVIEW' }).kind).toBe('none');
    expect(nextStepOf({ ...base, status: 'PAUSED', pausedByAdmin: true }).kind).toBe('none');
    expect(nextStepOf({ ...base, status: 'PAUSED' }).kind).toBe('resume');
  });

  it('shares a selling event', () => {
    expect(nextStepOf({ ...base, status: 'PUBLISHED' })).toMatchObject({
      title: 'On sale now',
      href: '/organizer/events/e1/promote',
    });
  });
});
