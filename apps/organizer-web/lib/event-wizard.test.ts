import { describe, expect, it } from 'vitest';
import {
  REVIEW_STEP,
  WIZARD_STEPS,
  buyerFeeNote,
  canVisitStep,
  capacityBySession,
  describeProblems,
  fromPriceMinor,
  initialWizardDraft,
  isMeaningfulDraft,
  newTicketRow,
  sessionsToSend,
  ticketsToSend,
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
    admission: 'paid',
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
  const row = (over: Partial<WizardAnswers['tickets'][number]> = {}) => ({
    sessionIndex: 0,
    name: 'General',
    priceMajor: '499',
    quantityTotal: '100',
    maxPerOrder: '6',
    ...over,
  });
  const seated = { startsAt: 'a', endsAt: 'b', screenId: 'room-1', seatMapId: 'map-1' };

  it('asks how people get in before anything else', () => {
    expect(validateStep('tickets', valid({ admission: '' }))).toEqual({
      admission: 'Choose how people get in: free, paid or reserved seating.',
    });
  });

  it('requires a name, a price of 0 or more and a quantity of at least 1', () => {
    const e = validateStep(
      'tickets',
      valid({ tickets: [row({ name: ' ', priceMajor: '-1', quantityTotal: '0' })] }),
    );
    expect(Object.keys(e)).toEqual(['t0Name', 't0Price', 't0Qty']);
  });

  it('accepts a price of zero on a paid event', () => {
    expect(validateStep('tickets', valid({ tickets: [row({ priceMajor: '0' })] }))).toEqual({});
  });

  it('does not ask for a price on a free event - there is no price field', () => {
    const t = row({ priceMajor: '' });
    expect(validateStep('tickets', valid({ admission: 'free', tickets: [t] }))).toEqual({});
    expect(Object.keys(validateStep('tickets', valid({ tickets: [t] })))).toEqual(['t0Price']);
  });

  it('checks every row on its own, so several ticket types can each be wrong', () => {
    const e = validateStep(
      'tickets',
      valid({ tickets: [row(), row({ name: 'VIP', priceMajor: '', quantityTotal: '' })] }),
    );
    expect(Object.keys(e)).toEqual(['t1Price', 't1Qty']);
  });

  it('wants whole tickets, and a limit per order no bigger than what is on sale', () => {
    expect(validateStep('tickets', valid({ tickets: [row({ quantityTotal: '1.5' })] }))).toEqual({
      t0Qty: 'Quantity must be a whole number, at least 1.',
    });
    expect(
      validateStep('tickets', valid({ tickets: [row({ quantityTotal: '4', maxPerOrder: '6' })] })),
    ).toEqual({ t0Max: 'Max per order cannot be more than the quantity on sale.' });
    expect(validateStep('tickets', valid({ tickets: [row({ maxPerOrder: '0' })] }))).toEqual({
      t0Max: 'Max per order must be a whole number, at least 1.',
    });
    // Blank keeps meaning "the platform default", as it always has.
    expect(validateStep('tickets', valid({ tickets: [row({ maxPerOrder: '' })] }))).toEqual({});
  });

  it('refuses two ticket types with the same name on the same session, not on different ones', () => {
    const two = [
      { startsAt: 'a', endsAt: 'b', screenId: '', seatMapId: '' },
      { startsAt: 'c', endsAt: 'd', screenId: '', seatMapId: '' },
    ];
    expect(
      validateStep('tickets', valid({ tickets: [row(), row({ name: ' general ' })] })),
    ).toEqual({ t1Name: 'Another ticket type for this session has the same name.' });
    expect(
      validateStep('tickets', valid({ sessions: two, tickets: [row(), row({ sessionIndex: 1 })] })),
    ).toEqual({});
  });

  it('asks for a seat map per session for reserved seating, and no ticket types', () => {
    expect(
      validateStep('tickets', valid({ admission: 'seated', sessions: [seated], tickets: [] })),
    ).toEqual({});
    const open = { startsAt: 'a', endsAt: 'b', screenId: '', seatMapId: '' };
    expect(
      validateStep('tickets', valid({ admission: 'seated', sessions: [seated, open] })),
    ).toEqual({ s1Seat: 'Choose a seat map.' });
  });

  it('refuses a seat map from another venue once the venue list is known', () => {
    const a = valid({ admission: 'seated', sessions: [seated] });
    expect(validateStep('tickets', { ...a, venueSeatMaps: ['map-2'] })).toEqual({
      s0Seat: 'This seat map is not at the venue you picked. Choose another.',
    });
    expect(validateStep('tickets', { ...a, venueSeatMaps: ['map-1'] })).toEqual({});
    // Unknown (still loading) is not a reason to refuse.
    expect(validateStep('tickets', { ...a, venueSeatMaps: null })).toEqual({});
  });

  it('ignores a row bound to a session that no longer exists, and needs one that does', () => {
    const e = validateStep('tickets', valid({ tickets: [row({ sessionIndex: 3, name: '' })] }));
    expect(e).toEqual({ form: 'Add at least one ticket type.' });
  });
});

describe('what is sent', () => {
  it('sends a room only for reserved seating, whatever an earlier choice left behind', () => {
    const sessions = [{ startsAt: 'a', endsAt: 'b', screenId: 'room-1', seatMapId: 'map-1' }];
    expect(sessionsToSend({ admission: 'seated', sessions })).toEqual(sessions);
    expect(sessionsToSend({ admission: 'paid', sessions })[0]).toMatchObject({
      screenId: '',
      seatMapId: '',
    });
    expect(sessionsToSend({ admission: 'free', sessions })[0].screenId).toBe('');
  });

  it('sends no typed ticket types for reserved seating - the seat map makes them', () => {
    const a = valid();
    expect(ticketsToSend({ ...a, admission: 'seated' })).toEqual([]);
    expect(ticketsToSend(a)).toEqual(a.tickets);
  });

  it('adds up what is on sale per session, counting only whole tickets', () => {
    const sessions = [
      { startsAt: 'a', endsAt: 'b', screenId: '', seatMapId: '' },
      { startsAt: 'c', endsAt: 'd', screenId: '', seatMapId: '' },
    ];
    const tickets = [
      { sessionIndex: 0, name: 'General', priceMajor: '1', quantityTotal: '100', maxPerOrder: '' },
      { sessionIndex: 0, name: 'VIP', priceMajor: '1', quantityTotal: '20', maxPerOrder: '' },
      { sessionIndex: 1, name: 'General', priceMajor: '1', quantityTotal: 'x', maxPerOrder: '' },
    ];
    expect(capacityBySession({ admission: 'paid', sessions, tickets })).toEqual([120, 0]);
    expect(capacityBySession({ admission: 'seated', sessions, tickets })).toEqual([0, 0]);
  });

  it('starts a new ticket row empty, with the first row limit per order', () => {
    expect(newTicketRow([{ ...valid().tickets[0], maxPerOrder: '4' }])).toEqual({
      sessionIndex: 0,
      name: '',
      priceMajor: '',
      quantityTotal: '',
      maxPerOrder: '4',
    });
  });
});

describe('what the buyer sees', () => {
  const answers = (over: Partial<WizardAnswers> = {}) => valid(over);

  it('shows the lowest price, free as zero, and nothing it cannot know', () => {
    const tickets = [
      { sessionIndex: 0, name: 'VIP', priceMajor: '999.5', quantityTotal: '5', maxPerOrder: '' },
      { sessionIndex: 0, name: 'General', priceMajor: '499', quantityTotal: '5', maxPerOrder: '' },
    ];
    expect(fromPriceMinor(answers({ tickets }))).toBe(49_900);
    expect(fromPriceMinor(answers({ admission: 'free', tickets }))).toBe(0);
    expect(fromPriceMinor(answers({ admission: 'seated' }))).toBeNull();
    expect(fromPriceMinor(answers({ admission: '' }))).toBeNull();
    expect(fromPriceMinor(answers({ tickets: [{ ...tickets[0], priceMajor: '' }] }))).toBeNull();
  });

  it('says what happens about fees for each way of paying them, in ASCII', () => {
    expect(buyerFeeNote('free', 'CUSTOMER_PAYS')).toMatch(/No checkout and no fees/);
    expect(buyerFeeNote('paid', 'CUSTOMER_PAYS')).toMatch(/^Plus booking and payment fees/);
    expect(buyerFeeNote('paid', 'SHARED')).toMatch(/half/);
    expect(buyerFeeNote('seated', 'ORGANIZER_PAYS')).toMatch(/No fees added/);
    for (const mode of ['CUSTOMER_PAYS', 'SHARED', 'ORGANIZER_PAYS'])
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7E]*$/.test(buyerFeeNote('paid', mode))).toBe(true);
  });
});

describe('the problems, in words', () => {
  it('says which session or ticket type a problem belongs to', () => {
    expect(
      describeProblems({
        title: 'Title must be at least 3 characters.',
        s1End: 'End time is required.',
        s0Seat: 'Choose a seat map.',
        t2Max: 'Max per order must be a whole number, at least 1.',
        form: 'Add at least one ticket type.',
      }),
    ).toEqual([
      'Title must be at least 3 characters.',
      'Session 2: End time is required.',
      'Session 1: Choose a seat map.',
      'Ticket type 3: Max per order must be a whole number, at least 1.',
      'Add at least one ticket type.',
    ]);
  });

  it("names a session and a ticket the way this event's headings do", () => {
    expect(
      describeProblems(
        { s0Start: 'Start time is required.', t1Name: 'Name is required.' },
        { session: 'Day', ticket: 'Pass' },
      ),
    ).toEqual(['Day 1: Start time is required.', 'Pass 2: Name is required.']);
  });

  it('lists nothing for a step with nothing missing', () => {
    expect(describeProblems(validateStep('tickets', valid()))).toEqual([]);
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
    expect(fieldIdForError('t0Max', 'list')).toBe('tm0');
    expect(fieldIdForError('s1Seat', 'list')).toBe('sr1');
    expect(fieldIdForError('admission', 'list')).toBe('admission');
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

  it('names the status the event will have after Submit, in the console vocabulary', () => {
    expect(whatHappensNext(false).submitStatus).toBe('In review');
    expect(whatHappensNext(true).submitStatus).toBe('Published');
  });

  it('is plain ASCII', () => {
    const all = Object.values(whatHappensNext(false)).concat(Object.values(whatHappensNext(true)));
    // eslint-disable-next-line no-control-regex
    for (const line of all) expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
  });
});

describe('the saved draft', () => {
  const draft: WizardDraft = {
    experience: 'community',
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
    admission: 'seated',
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

  it('restores a draft saved before the experience question with no experience', () => {
    // The page then works it out from the category; the lib does not guess.
    const { experience: _gone, ...old } = draft;
    expect(restoreWizardDraft(old)?.experience).toBe('');
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

  it('reads the answer from a draft saved before the question existed', () => {
    const older = { ...draft } as Record<string, unknown>;
    delete older.admission;
    const ga = [{ ...draft.sessions[0], screenId: '', seatMapId: '' }];
    // A room on a session was reserved seating.
    expect(restoreWizardDraft(older)?.admission).toBe('seated');
    // The free switch was free.
    expect(restoreWizardDraft({ ...older, sessions: ga, isFree: true })?.admission).toBe('free');
    // Paid was the default once past the tickets step, and is unanswered before it.
    expect(
      restoreWizardDraft({ ...older, sessions: ga, isFree: false, step: 3, furthest: 3 })
        ?.admission,
    ).toBe('paid');
    expect(
      restoreWizardDraft({ ...older, sessions: ga, isFree: false, step: 1, furthest: 1 })
        ?.admission,
    ).toBe('');
  });
});

describe('whether a draft is worth restoring', () => {
  const blank = initialWizardDraft();

  it('is not, when nothing was entered - however far the steps were clicked', () => {
    expect(isMeaningfulDraft(blank, blank)).toBe(false);
    expect(isMeaningfulDraft({ ...blank, step: 1, furthest: 1 }, blank)).toBe(false);
    // The venue tab and the category mode say nothing until something is typed under them.
    expect(isMeaningfulDraft({ ...blank, venueMode: 'new', categoryMode: 'other' }, blank)).toBe(
      false,
    );
    // The new-venue location starts from the visitor's own country, not from a choice.
    expect(
      isMeaningfulDraft(
        { ...blank, newVenueWhere: { country: 'IN', region: 'TG', timezone: 'Asia/Kolkata' } },
        blank,
      ),
    ).toBe(false);
  });

  it('is not, when it holds only what a template filled in', () => {
    const seed = { title: 'Live in Concert', category: 'Music', description: 'A night' };
    expect(isMeaningfulDraft(initialWizardDraft(seed), initialWizardDraft(seed))).toBe(false);
  });

  it('is, as soon as any one answer differs from the blank form', () => {
    const changes: Partial<WizardDraft>[] = [
      { basics: { ...blank.basics, title: 'Jazz' } },
      { basics: { ...blank.basics, refundsEnabled: false } },
      { details: { ...blank.details, ageLimit: '18' } },
      { admission: 'free' },
      { venueId: 'venue-1' },
      { newVenue: { ...blank.newVenue, city: 'Pune' } },
      { feeMode: 'SHARED' },
      { sessions: [{ ...blank.sessions[0], startsAt: '2027-03-14T19:00' }] },
      { tickets: [{ ...blank.tickets[0], priceMajor: '499' }] },
    ];
    for (const change of changes)
      expect(isMeaningfulDraft({ ...blank, ...change }, blank)).toBe(true);
  });

  it("takes the experience's name for the first ticket row, still with no price", () => {
    const pass = initialWizardDraft({ experience: 'conference', ticketName: 'Standard pass' });
    expect(pass.experience).toBe('conference');
    expect(pass.tickets[0]).toMatchObject({ name: 'Standard pass', priceMajor: '' });
  });

  it('starts with one General row of 100 tickets and no price typed for the organizer', () => {
    expect(blank.tickets).toEqual([
      { sessionIndex: 0, name: 'General', priceMajor: '', quantityTotal: '100', maxPerOrder: '6' },
    ]);
    expect(blank.admission).toBe('');
  });
});
