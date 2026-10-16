import { describe, expect, it } from 'vitest';
import {
  hasSessionToday,
  lifecycleOf,
  nextStepOf,
  pauseNoticeOf,
  saleStateOf,
  setupOf,
  type SaleState,
} from './event-lifecycle';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const HOUR = 3_600_000;

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
      'Paused by ETicketsGo',
    );
    expect(lifecycleOf({ status: 'PAUSED' }).detail?.label).toBe('Paused');
    expect(lifecycleOf({ status: 'SOLD_OUT' }).detail?.label).toBe('Sold out');
  });
});

describe('saleStateOf: the server answer, in words', () => {
  const reason = (code: string, text: string, message: string) => ({
    code: code as never,
    text,
    message,
    owner: 'ORGANIZER' as const,
    fixPath: null,
    ticketTypeIds: [],
    affectedSessions: 1,
  });

  it('is Selling only when the server says SELLING', () => {
    expect(saleStateOf({ answer: { state: 'SELLING', reasons: [] } })).toEqual({
      state: 'SELLING',
      selling: true,
      label: 'Selling',
      tone: 'success',
    });
  });

  it('never says bare Selling for a partly selling event', () => {
    const s = saleStateOf({
      answer: {
        state: 'PARTIAL',
        reasons: [
          reason('SEAT_CLASS_UNMAPPED', 'seat classes not mapped', 'Map Standard to a class.'),
        ],
      },
    });
    expect(s).toEqual({
      state: 'PARTIAL',
      selling: false,
      label: 'Partly selling: seat classes not mapped',
      tone: 'info',
      detail: 'Map Standard to a class.',
    });
  });

  it('says why it is not selling, from the server, including a draft', () => {
    expect(
      saleStateOf({
        answer: {
          state: 'NOT_SELLING',
          reasons: [reason('EVENT_NOT_PUBLISHED', 'draft, not submitted', 'Publish it.')],
        },
      }).label,
    ).toBe('Not selling: draft, not submitted');
  });

  it('does not guess while the answer is pending or failed', () => {
    expect(saleStateOf({ answer: undefined })).toEqual({
      state: null,
      selling: null,
      label: 'Checking sales',
      tone: 'neutral',
    });
    expect(saleStateOf({ answer: undefined, failed: true }).label).toBe('Sale check unavailable');
  });
});

describe('setupOf', () => {
  it('counts the organizer issues once each; a description and picture are suggestions', () => {
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
    expect(setup.label).toBe('1 thing to set up');
    expect(setup.items.map((i) => i.label)).toEqual(['No ticket types']);
    expect(setup.suggestions.map((i) => i.label)).toEqual([
      'Add a description',
      'Add a cover picture',
    ]);
  });

  it('agrees with the create wizard: no picture and no description is still Setup complete', () => {
    // The wizard calls both optional and ends on "Setup complete"; the event page said
    // "2 things to set up" about the same event a second later.
    const setup = setupOf({ eventId: 'e1', description: '', hasImage: false, issues: [] });
    expect(setup.complete).toBe(true);
    expect(setup.label).toBe('Setup complete');
    expect(setup.suggestions).toHaveLength(2);
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
  const selling: SaleState = {
    state: 'SELLING',
    selling: true,
    label: 'Selling',
    tone: 'success',
  };
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
    expect(nextStepOf({ ...base, status: 'PAUSED' }).kind).toBe('resume');
  });

  it('sends a platform pause to support, never to a Resume that would fail', () => {
    const step = nextStepOf({ ...base, status: 'PAUSED', pausedByAdmin: true });
    expect(step).toMatchObject({
      kind: 'link',
      label: 'Ask ETicketsGo to resume',
      href: '/organizer/help?event=e1#support',
    });
    expect(step.body).toMatch(/Only ETicketsGo can lift this pause/);
  });

  it('shares a selling event', () => {
    expect(nextStepOf({ ...base, status: 'PUBLISHED' })).toMatchObject({
      title: 'On sale now',
      href: '/organizer/events/e1/promote',
    });
  });
});

describe('pauseNoticeOf: what the platform team said', () => {
  it('leads with the reason in their words', () => {
    expect(
      pauseNoticeOf({
        status: 'PAUSED',
        pausedByAdmin: true,
        pausedByAdminReason: ' The age limit is missing. ',
      })?.headline,
    ).toBe('Paused by ETicketsGo: The age limit is missing.');
  });

  it('says no reason was recorded rather than ending on a colon', () => {
    const n = pauseNoticeOf({ status: 'PAUSED', pausedByAdmin: true, pausedByAdminReason: null });
    expect(n?.headline).toBe('Paused by ETicketsGo');
    expect(n?.detail).toMatch(/No reason was recorded/);
  });

  it('is silent for a pause the organizer made, and for an event on sale', () => {
    expect(pauseNoticeOf({ status: 'PAUSED', pausedByAdmin: false })).toBeNull();
    expect(
      pauseNoticeOf({ status: 'PUBLISHED', pausedByAdmin: true, pausedByAdminReason: 'old' }),
    ).toBeNull();
  });
});
