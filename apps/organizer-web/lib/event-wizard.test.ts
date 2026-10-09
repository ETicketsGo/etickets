import { describe, expect, it } from 'vitest';
import {
  REVIEW_STEP,
  WIZARD_STEPS,
  canVisitStep,
  fieldIdForError,
  firstInvalidFieldId,
  firstInvalidStep,
  restoreWizardDraft,
  serializeWizardDraft,
  stepStatus,
  validateAll,
  validateStep,
  whatHappensNext,
  type WizardAnswers,
  type WizardDraft,
} from './event-wizard';

/**
 * The create-event wizard's rules: what each step requires, how the indicator reads, where the
 * cursor goes, and that a saved draft comes back as it went in. The page renders these; if one
 * of them is wrong, an organizer is either stopped for nothing or let through to an API refusal.
 */

/** A form that would be accepted as it stands. Each test breaks the one thing it is about. */
function valid(overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    basics: { title: 'Jazz night', category: 'Music' },
    isFree: false,
    venueMode: 'existing',
    venueId: 'venue-1',
    newVenue: { name: '', city: '' },
    sessions: [
      {
        startsAt: '2027-03-14T19:00',
        endsAt: '2027-03-14T21:00',
        screenId: '',
        seatMapId: '',
      },
    ],
    tickets: [
      {
        sessionIndex: 0,
        name: 'General',
        priceMajor: '499',
        quantityTotal: '100',
        maxPerOrder: '6',
      },
    ],
    ...overrides,
  };
}

describe('the steps', () => {
  it('run basics, where and when, tickets, details, review - in that order', () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual([
      'basics',
      'where',
      'tickets',
      'details',
      'review',
    ]);
    expect(REVIEW_STEP).toBe(4);
  });

  it('each say what is required, in ASCII', () => {
    for (const step of WIZARD_STEPS) {
      expect(step.required.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7E]*$/.test(`${step.title}${step.intro}${step.required}`)).toBe(true);
    }
  });

  it('accept a complete form with no errors anywhere', () => {
    expect(firstInvalidStep(valid())).toBe(-1);
  });
});

describe('basics', () => {
  it('requires a title of at least 3 characters and a category', () => {
    const e = validateStep('basics', valid({ basics: { title: ' ab ', category: '  ' } }));
    expect(Object.keys(e)).toEqual(['title', 'category']);
  });

  it('accepts a 3-character title', () => {
    expect(validateStep('basics', valid({ basics: { title: 'Gig', category: 'Music' } }))).toEqual(
      {},
    );
  });
});

describe('where and when', () => {
  it('requires an existing venue to be picked', () => {
    expect(Object.keys(validateStep('where', valid({ venueId: '' })))).toEqual(['venueId']);
  });

  it('requires a new venue to have a name and a city, and not an existing id', () => {
    const e = validateStep(
      'where',
      valid({ venueMode: 'new', venueId: '', newVenue: { name: '', city: '' } }),
    );
    expect(Object.keys(e)).toEqual(['venueName', 'venueCity']);
  });

  it('requires a start and an end for every session', () => {
    const e = validateStep(
      'where',
      valid({
        sessions: [
          { startsAt: '', endsAt: '', screenId: '', seatMapId: '' },
          { startsAt: '2027-03-14T19:00', endsAt: '', screenId: '', seatMapId: '' },
        ],
      }),
    );
    expect(e).toEqual({
      s0Start: 'Start time is required.',
      s0End: 'End time is required.',
      s1End: 'End time is required.',
    });
  });

  it('refuses an end at or before the start', () => {
    const e = validateStep(
      'where',
      valid({
        sessions: [
          {
            startsAt: '2027-03-14T19:00',
            endsAt: '2027-03-14T19:00',
            screenId: '',
            seatMapId: '',
          },
        ],
      }),
    );
    expect(e).toEqual({ s0End: 'End must be after start.' });
  });

  it('requires at least one session', () => {
    expect(validateStep('where', valid({ sessions: [] })).form).toBe('Add at least one session.');
  });
});

describe('tickets and pricing', () => {
  it('requires a name, a price of 0 or more and a quantity of at least 1', () => {
    const e = validateStep(
      'tickets',
      valid({
        tickets: [
          { sessionIndex: 0, name: ' ', priceMajor: '-1', quantityTotal: '0', maxPerOrder: '6' },
        ],
      }),
    );
    expect(Object.keys(e)).toEqual(['t0Name', 't0Price', 't0Qty']);
  });

  it('accepts a price of zero on a paid event', () => {
    const t = {
      sessionIndex: 0,
      name: 'Comp',
      priceMajor: '0',
      quantityTotal: '5',
      maxPerOrder: '6',
    };
    expect(validateStep('tickets', valid({ tickets: [t] }))).toEqual({});
  });

  it('does not judge the price on a free event - the field is pinned at zero', () => {
    const t = {
      sessionIndex: 0,
      name: 'Entry',
      priceMajor: '',
      quantityTotal: '5',
      maxPerOrder: '6',
    };
    expect(validateStep('tickets', valid({ isFree: true, tickets: [t] }))).toEqual({});
    expect(Object.keys(validateStep('tickets', valid({ tickets: [t] })))).toEqual(['t0Price']);
  });

  it('asks for nothing when every session is seated - the seat map makes the ticket types', () => {
    const seated = { startsAt: 'a', endsAt: 'b', screenId: 'room-1', seatMapId: 'map-1' };
    expect(validateStep('tickets', valid({ sessions: [seated], tickets: [] }))).toEqual({});
  });

  it('ignores a ticket row left on a seated session, and needs one on the open session', () => {
    const seated = { startsAt: 'a', endsAt: 'b', screenId: 'room-1', seatMapId: 'map-1' };
    const open = { startsAt: 'a', endsAt: 'b', screenId: '', seatMapId: '' };
    const onSeated = {
      sessionIndex: 0,
      name: '',
      priceMajor: '',
      quantityTotal: '',
      maxPerOrder: '6',
    };
    const e = validateStep('tickets', valid({ sessions: [seated, open], tickets: [onSeated] }));
    expect(e).toEqual({ form: 'Add at least one ticket type.' });
  });
});

describe('image and details, and review', () => {
  it('require nothing', () => {
    const empty = valid({ basics: { title: '', category: '' }, venueId: '', sessions: [] });
    expect(validateStep('details', empty)).toEqual({});
    expect(validateStep('review', empty)).toEqual({});
  });
});

describe('the step indicator', () => {
  it('marks the current step, passed steps as complete or in error, later ones as upcoming', () => {
    const errors = validateAll(valid({ venueId: '' }));
    const statuses = WIZARD_STEPS.map((_, i) => stepStatus(i, 2, 3, errors));
    expect(statuses).toEqual(['complete', 'error', 'current', 'complete', 'upcoming']);
  });

  it('does not flag a step nobody has reached yet, however empty it is', () => {
    const errors = validateAll(valid({ venueId: '', sessions: [] }));
    expect(stepStatus(1, 0, 0, errors)).toBe('upcoming');
  });

  it('follows the answers as they are NOW, so fixing an earlier step clears its flag', () => {
    expect(stepStatus(1, 2, 2, validateAll(valid({ venueId: '' })))).toBe('error');
    expect(stepStatus(1, 2, 2, validateAll(valid()))).toBe('complete');
  });

  it('lets any reached step be revisited, and none beyond it', () => {
    expect([0, 1, 2, 3, 4].map((i) => canVisitStep(i, 2))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('reports the first step with a problem', () => {
    expect(firstInvalidStep(valid({ tickets: [] }))).toBe(2);
    expect(firstInvalidStep(valid({ tickets: [], basics: { title: '', category: 'x' } }))).toBe(0);
  });
});

describe('where the cursor goes', () => {
  it('maps every error key to the field the wizard draws for it', () => {
    expect(fieldIdForError('title', 'list')).toBe('title');
    expect(fieldIdForError('category', 'list')).toBe('category');
    expect(fieldIdForError('category', 'other')).toBe('category-other');
    expect(fieldIdForError('venueId', 'list')).toBe('venue');
    expect(fieldIdForError('venueName', 'list')).toBe('vname');
    expect(fieldIdForError('venueCity', 'list')).toBe('vcity');
    expect(fieldIdForError('s2Start', 'list')).toBe('ss2');
    expect(fieldIdForError('s0End', 'list')).toBe('se0');
    expect(fieldIdForError('t1Name', 'list')).toBe('tn1');
    expect(fieldIdForError('t1Price', 'list')).toBe('tp1');
    expect(fieldIdForError('t10Qty', 'list')).toBe('tq10');
    expect(fieldIdForError('form', 'list')).toBeNull();
  });

  it('picks the first field in the order the step shows them', () => {
    const e = validateStep(
      'where',
      valid({
        venueId: '',
        sessions: [{ startsAt: '', endsAt: '', screenId: '', seatMapId: '' }],
      }),
    );
    expect(firstInvalidFieldId(e, 'list')).toBe('venue');
    expect(firstInvalidFieldId({ form: 'Add at least one ticket type.' }, 'list')).toBeNull();
  });
});

describe('what happens next', () => {
  it('says submitting goes to review, unless the organization is trusted to publish', () => {
    expect(whatHappensNext(false).submit).toMatch(/sends the event to our team/);
    expect(whatHappensNext(true).submit).toMatch(/publishes the event at once/);
    expect(whatHappensNext(false).saveDraft).toMatch(/draft/);
  });

  it('is plain ASCII', () => {
    const all = Object.values(whatHappensNext(false)).concat(Object.values(whatHappensNext(true)));
    // eslint-disable-next-line no-control-regex
    for (const line of all) expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
  });
});

describe('the saved draft', () => {
  const draft: WizardDraft = {
    step: 2,
    furthest: 3,
    basics: {
      title: 'Jazz night',
      category: 'Poetry reading',
      description: 'An evening',
      refundPolicy: 'No pets',
      refundsEnabled: false,
      refundCutoffHours: '24',
    },
    details: {
      ageLimit: '18',
      artists: [{ name: 'Asha', role: 'Singer', bio: '' }],
      termsAndConditions: 'Bring ID',
    },
    categoryMode: 'other',
    isFree: true,
    venueMode: 'new',
    venueId: '',
    newVenue: { name: 'Hall', city: 'Pune', address: '1 Road', capacity: '200' },
    newVenueWhere: { country: 'IN', region: 'MH', timezone: 'Asia/Kolkata' },
    feeMode: 'SHARED',
    sessions: [
      { startsAt: '2027-03-14T19:00', endsAt: '2027-03-14T21:00', screenId: 'r', seatMapId: 'm' },
    ],
    tickets: [
      { sessionIndex: 0, name: 'Entry', priceMajor: '0', quantityTotal: '50', maxPerOrder: '4' },
    ],
  };

  it('comes back exactly as it was saved', () => {
    expect(restoreWizardDraft(serializeWizardDraft(draft))).toEqual(draft);
    expect(restoreWizardDraft(JSON.parse(serializeWizardDraft(draft)))).toEqual(draft);
  });

  it('is refused whole when it is not a draft at all', () => {
    expect(restoreWizardDraft('not json')).toBeNull();
    expect(restoreWizardDraft(null)).toBeNull();
    expect(restoreWizardDraft({ basics: {} })).toBeNull();
    expect(restoreWizardDraft({ ...draft, sessions: ['x'] })).toBeNull();
  });

  it('keeps the step inside the wizard and never behind the furthest step reached', () => {
    expect(restoreWizardDraft({ ...draft, step: 99, furthest: 0 })).toMatchObject({
      step: REVIEW_STEP,
      furthest: REVIEW_STEP,
    });
    expect(restoreWizardDraft({ ...draft, step: -3, furthest: 'x' })).toMatchObject({
      step: 0,
      furthest: 0,
    });
  });

  it('fills what an older draft never had with the defaults the page starts with', () => {
    const older = { ...draft } as Record<string, unknown>;
    delete older.details;
    delete older.furthest;
    delete older.newVenueWhere;
    const restored = restoreWizardDraft(older);
    expect(restored?.details).toEqual({ ageLimit: '', artists: [], termsAndConditions: '' });
    expect(restored?.furthest).toBe(2);
    expect(restored?.newVenueWhere).toBeNull();
  });
});
