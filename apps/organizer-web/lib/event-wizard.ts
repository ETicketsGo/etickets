/**
 * The rules of the create-event wizard, kept apart from the page that draws it.
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────────────
 * Founder feedback on the wizard: a first-time organizer did not know what to fill in first,
 * what was needed before tickets could be sold, or what would happen when they pressed the
 * last button. The first step alone held the title, the category, the description, the
 * performers, the terms, the pictures, the refund rule and the free-event switch.
 *
 * The answer is more steps, each asking one kind of question - and more steps means more
 * rules about steps: which fields each one requires, whether a step the organizer has already
 * passed has since been broken by something they changed elsewhere, and which field to put
 * the cursor in. Those rules are pure, so they live here and are tested here. The page only
 * renders them.
 *
 * Nothing in this file decides what the API accepts. Every check below is one the page
 * already made before it was split into these steps, moved, not invented.
 */

import type { EventArtist, LocationValue } from '@eticketsgo/web-kit';

export type WizardStepId = 'basics' | 'where' | 'tickets' | 'details' | 'review';

export interface WizardStep {
  id: WizardStepId;
  /** Short name in the step indicator. */
  title: string;
  /** One line under the step heading: what this step is for, in the organizer's terms. */
  intro: string;
  /**
   * What must be answered before Next will move on, said up front. A first-time organizer
   * could not tell what was needed to sell from what could wait; this is that line, per step.
   */
  required: string;
  /**
   * Two or three short tips for the help panel beside the form. Hints, not instructions: the
   * form must be completable without reading them, so nothing here is a rule.
   */
  tips: readonly string[];
}

/*
  Ordered by what an organizer KNOWS first, not by what the database needs first.

  Everybody starting an event knows what it is called. Most know where and when. Prices come
  next, because a price only means something once there is a venue (it decides the currency)
  and a session (a seated room decides the ticket types). Performers, terms and the refund rule
  are the things people come back to fill in, so they are last and nothing on that step is
  required.

  The pictures moved to the first step. They were on the last optional one, so the live preview
  beside the form showed "no image" for the whole flow, and the most visual part of an event was
  the part most often skipped. They are still optional and still not sent until the end.
*/
export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    id: 'basics',
    title: 'Basics',
    intro: 'What the event is called, how buyers find it, and its pictures.',
    required: 'Needed: a title and a category. Pictures are optional.',
    tips: [
      'Put the name buyers would search for first: the artist, the show or the team.',
      'A wide picture works best. The first one is the cover; click it to choose what always shows.',
      'You can change all of this later from the event page.',
    ],
  },
  {
    id: 'where',
    title: 'Where and when',
    intro: 'The venue, and each date and time the event happens.',
    required: 'Needed: a venue, and a start and end time for each date.',
    tips: [
      "Times are in the venue's time zone, wherever you are typing from.",
      'A run of dates is still one event. Add each date here.',
      "The venue's country sets the currency you sell in.",
    ],
  },
  {
    id: 'tickets',
    title: 'Tickets',
    intro: 'How people get in, what you sell and for how much.',
    required:
      'Needed: free, paid or reserved seating. Free and paid need at least one ticket with a name and a quantity.',
    tips: [
      'Quantity is how many you sell, not how many the venue holds.',
      'Reserved seating needs a published seat map at the venue. Its seat categories set the prices.',
      'Free events have no checkout and no fees.',
    ],
  },
  {
    id: 'details',
    title: 'Details',
    intro: 'What buyers should know, and your refund rule. You can change all of these later.',
    required: 'Nothing here is required.',
    tips: [
      'Buyers see the age limit and terms before they pay.',
      'Turning refunds off hides the refund button. Your team can still refund by hand.',
    ],
  },
  {
    id: 'review',
    title: 'Review',
    intro: 'Check what buyers will see, then create the event.',
    required: 'Nothing is created until you press one of the buttons at the end.',
    tips: [
      'A draft is only visible to your team. Nothing is sold.',
      'Submitting never publishes on its own unless an administrator set your organization to publish without review.',
    ],
  },
];

export const STEP_COUNT = WIZARD_STEPS.length;
export const REVIEW_STEP = STEP_COUNT - 1;
export const TICKETS_STEP = WIZARD_STEPS.findIndex((s) => s.id === 'tickets');

export interface SessionDraft {
  startsAt: string;
  endsAt: string;
  /**
   * The room this session plays in, or '' for general admission.
   *
   * Per SESSION rather than per event, because it genuinely varies: a run of shows can move
   * from the main auditorium to the studio, and the same event is reserved seating in one
   * and general admission in the other.
   */
  screenId: string;
  /** The named configuration selected inside that space. Empty for general admission. */
  seatMapId: string;
}

export interface TicketDraft {
  sessionIndex: number;
  name: string;
  /** Entered in MAJOR units of the venue's currency - rupees in India, dollars in the US. */
  priceMajor: string;
  quantityTotal: string;
  maxPerOrder: string;
}

/**
 * How people get in: the first question on the tickets step.
 *
 * ── WHY ONE CHOICE INSTEAD OF A CHECKBOX AND A DROPDOWN ───────────────────────────
 * Free was a checkbox on the tickets step and reserved seating was a dropdown on every session
 * of the step before. An organizer had to find both, in two places, and the combinations they
 * allowed were not all real: a free event in a seated room gets one PRICED ticket type per seat
 * category, which the API then refuses on a free event. Three answers, asked together, are the
 * three events this wizard can actually create.
 *
 * '' is "not answered yet". The step will not move on until it is answered, because each
 * answer changes what is asked next.
 */
export type Admission = '' | 'free' | 'paid' | 'seated';

export const ADMISSION_CHOICES: readonly { value: Exclude<Admission, ''>; label: string }[] = [
  { value: 'free', label: 'Free event' },
  { value: 'paid', label: 'Paid - general admission' },
  { value: 'seated', label: 'Reserved seating' },
];

/** The answers the step rules read. The page holds more; none of the rest is required. */
export interface WizardAnswers {
  basics: { title: string; category: string };
  admission: Admission;
  venueMode: 'existing' | 'new';
  venueId: string;
  newVenue: { name: string; city: string };
  sessions: SessionDraft[];
  tickets: TicketDraft[];
  /**
   * The seat maps that can be used at the chosen venue, or null while that is not known.
   *
   * Known only to the page (it is a server answer). When it is known, a session left on a seat
   * map of ANOTHER venue - the venue was changed after the seats were chosen - is caught here
   * instead of creating an event whose seats are in a different building.
   */
  venueSeatMaps?: readonly string[] | null;
}

export type FieldErrors = Record<string, string>;

export const EMPTY_SESSION: SessionDraft = {
  startsAt: '',
  endsAt: '',
  screenId: '',
  seatMapId: '',
};

/** True when the organizer said nobody pays. Declared, never inferred from the prices. */
export function isFreeAdmission(admission: Admission): boolean {
  return admission === 'free';
}

/**
 * The sessions as they will be sent.
 *
 * Only reserved seating keeps a room on a session. Free and paid general admission send every
 * session without one, whatever an earlier choice left behind, so the answer on the chooser is
 * the only thing that decides whether the event sells named seats.
 */
export function sessionsToSend(
  answers: Pick<WizardAnswers, 'admission' | 'sessions'>,
): SessionDraft[] {
  if (answers.admission === 'seated') return answers.sessions;
  return answers.sessions.map((s) => ({ ...s, screenId: '', seatMapId: '' }));
}

/**
 * The ticket rows that will actually be sent.
 *
 * None for reserved seating: a seated session gets one ticket type per seat category, priced
 * from the category, and rows typed here would be a second, conflicting set of prices. For
 * free and paid, every row - each is bound to a session that exists.
 */
export function ticketsToSend(
  answers: Pick<WizardAnswers, 'admission' | 'sessions' | 'tickets'>,
): TicketDraft[] {
  if (answers.admission === 'seated') return [];
  return answers.tickets.filter(
    (t) => t.sessionIndex >= 0 && t.sessionIndex < answers.sessions.length,
  );
}

/** Whole tickets on sale per session, for the running total under the ticket rows. */
export function capacityBySession(
  answers: Pick<WizardAnswers, 'admission' | 'sessions' | 'tickets'>,
): number[] {
  const totals = answers.sessions.map(() => 0);
  for (const t of ticketsToSend(answers)) {
    const n = Number(t.quantityTotal);
    if (Number.isInteger(n) && n > 0) totals[t.sessionIndex] += n;
  }
  return totals;
}

/**
 * A new ticket row, for "Add ticket type".
 *
 * Name and price start empty with an example in the placeholder, because a pre-filled second
 * name ("VIP") is the kind of default that gets published by accident. The limit per order
 * matches the first row's, which is the organizer's own answer to that question.
 */
export function newTicketRow(tickets: TicketDraft[], sessionIndex = 0): TicketDraft {
  return {
    sessionIndex,
    name: '',
    priceMajor: '',
    quantityTotal: '',
    maxPerOrder: tickets[0]?.maxPerOrder || '6',
  };
}

const isWholeNumber = (v: string) => /^\d+$/.test(v.trim());

/**
 * What is wrong with ONE step, keyed by field.
 *
 * The keys are the ones the page already used (`title`, `s0Start`, `t1Price`, ...), and
 * `form` is a problem with the step as a whole rather than with one field in it.
 */
export function validateStep(stepId: WizardStepId, a: WizardAnswers): FieldErrors {
  const e: FieldErrors = {};
  if (stepId === 'basics') {
    if (a.basics.title.trim().length < 3) e.title = 'Title must be at least 3 characters.';
    if (!a.basics.category.trim()) e.category = 'Category is required.';
  }
  if (stepId === 'where') {
    if (a.venueMode === 'existing' && !a.venueId) e.venueId = 'Select a venue.';
    if (a.venueMode === 'new') {
      if (!a.newVenue.name.trim()) e.venueName = 'Venue name is required.';
      if (!a.newVenue.city.trim()) e.venueCity = 'City is required.';
    }
    if (a.sessions.length === 0) e.form = 'Add at least one session.';
    a.sessions.forEach((s, i) => {
      if (!s.startsAt) e[`s${i}Start`] = 'Start time is required.';
      if (!s.endsAt) e[`s${i}End`] = 'End time is required.';
      if (s.startsAt && s.endsAt && new Date(s.endsAt) <= new Date(s.startsAt))
        e[`s${i}End`] = 'End must be after start.';
    });
  }
  if (stepId === 'tickets') {
    if (!a.admission) {
      e.admission = 'Choose how people get in: free, paid or reserved seating.';
    } else if (a.admission === 'seated') {
      a.sessions.forEach((s, i) => {
        if (!s.screenId || !s.seatMapId) e[`s${i}Seat`] = 'Choose a seat map.';
        else if (a.venueSeatMaps && !a.venueSeatMaps.includes(s.seatMapId))
          e[`s${i}Seat`] = 'This seat map is not at the venue you picked. Choose another.';
      });
    } else {
      // Only the rows that will actually be sent are judged: one bound to a session that no
      // longer exists is not sent, and refusing the form over it would be refusing a field
      // the organizer cannot see.
      const sent = ticketsToSend(a);
      if (sent.length === 0) e.form = 'Add at least one ticket type.';
      const free = isFreeAdmission(a.admission);
      a.tickets.forEach((t, i) => {
        if (!sent.includes(t)) return;
        const name = t.name.trim().toLowerCase();
        if (!name) {
          e[`t${i}Name`] = 'Name is required.';
        } else if (
          /*
            Two rows called "General" on the same night are two prices for what the buyer sees
            as one thing, and nothing on the event page would tell them apart.
          */
          a.tickets.some(
            (o, j) =>
              j < i && o.sessionIndex === t.sessionIndex && o.name.trim().toLowerCase() === name,
          )
        ) {
          e[`t${i}Name`] = 'Another ticket type for this session has the same name.';
        }
        if (
          !free &&
          (t.priceMajor === '' ||
            !Number.isFinite(Number(t.priceMajor)) ||
            Number(t.priceMajor) < 0)
        )
          e[`t${i}Price`] = 'Enter a valid price (0 or more).';
        // Whole tickets: "1.5" passed the old `>= 1` check and was then refused by the API.
        if (!isWholeNumber(t.quantityTotal) || Number(t.quantityTotal) < 1)
          e[`t${i}Qty`] = 'Quantity must be a whole number, at least 1.';
        // Blank is allowed and means the platform default, as it always has.
        if (t.maxPerOrder.trim() !== '') {
          if (!isWholeNumber(t.maxPerOrder) || Number(t.maxPerOrder) < 1)
            e[`t${i}Max`] = 'Max per order must be a whole number, at least 1.';
          else if (!e[`t${i}Qty`] && Number(t.maxPerOrder) > Number(t.quantityTotal))
            e[`t${i}Max`] = 'Max per order cannot be more than the quantity on sale.';
        }
      });
    }
  }
  return e;
}

/**
 * The problems on one step as a list a person can read without looking at the form.
 *
 * Field messages are written to sit under their field, where "Name is required." is clear. In a
 * list at the top of the step, or on Review, the same sentence needs to say WHICH name - so a
 * session's or a ticket type's problem is prefixed with which one it is.
 */
export function describeProblems(
  errors: FieldErrors,
  /*
    What this event calls a date and a kind of ticket. A conference's problem list says "Pass
    2", not "Ticket type 2", because "Pass 2" is the heading the organizer is looking at.
  */
  nouns: { session: string; ticket: string } = { session: 'Session', ticket: 'Ticket type' },
): string[] {
  return Object.entries(errors).map(([key, message]) => {
    let m = /^s(\d+)(Start|End|Seat)$/.exec(key);
    if (m) return `${nouns.session} ${Number(m[1]) + 1}: ${message}`;
    m = /^t(\d+)(Name|Price|Qty|Max)$/.exec(key);
    if (m) return `${nouns.ticket} ${Number(m[1]) + 1}: ${message}`;
    return message;
  });
}

/** Every step's errors at once, for the indicator and for the final check before creating. */
export function validateAll(a: WizardAnswers): Record<WizardStepId, FieldErrors> {
  return Object.fromEntries(WIZARD_STEPS.map((s) => [s.id, validateStep(s.id, a)])) as Record<
    WizardStepId,
    FieldErrors
  >;
}

/** The first step that still has a problem, or -1 when the whole form can be sent. */
export function firstInvalidStep(a: WizardAnswers): number {
  const all = validateAll(a);
  return WIZARD_STEPS.findIndex((s) => Object.keys(all[s.id]).length > 0);
}

export type StepStatus = 'current' | 'complete' | 'error' | 'upcoming';

/**
 * How one step is drawn in the indicator.
 *
 * A step the organizer has reached and left is either complete or in error, decided from the
 * answers as they are NOW - not as they were when the step was passed. Changing a session to
 * a seated room on "Where and when" really can fix or break "Tickets and pricing", and an
 * indicator that remembered the old verdict would send them looking for a problem that is
 * gone, or hide one that is new. Steps not yet reached are only upcoming: nobody has been
 * asked those questions, so their blanks are not mistakes.
 */
export function stepStatus(
  index: number,
  current: number,
  furthest: number,
  errorsByStep: Record<WizardStepId, FieldErrors>,
): StepStatus {
  if (index === current) return 'current';
  if (index > furthest) return 'upcoming';
  const id = WIZARD_STEPS[index]?.id;
  return id && Object.keys(errorsByStep[id] ?? {}).length > 0 ? 'error' : 'complete';
}

/**
 * Whether the indicator lets somebody jump to a step.
 *
 * Any step they have already reached, in either direction. Steps beyond that are reached with
 * Next, which checks the step in between - jumping past it would let an organizer arrive at
 * Review having never been asked for a venue.
 */
export function canVisitStep(index: number, furthest: number): boolean {
  return index >= 0 && index <= furthest;
}

/**
 * The element id the cursor should go to for an error key, or null when it is not a field.
 *
 * The ids are the wizard's own and the e2e suite drives them, so they are fixed: `ss0` is the
 * date input of the first session's start, `tp1` the second ticket type's price.
 */
export function fieldIdForError(key: string, categoryMode: 'list' | 'other'): string | null {
  if (key === 'title') return 'title';
  if (key === 'category') return categoryMode === 'other' ? 'category-other' : 'category';
  if (key === 'venueId') return 'venue';
  if (key === 'venueName') return 'vname';
  if (key === 'venueCity') return 'vcity';
  if (key === 'admission') return 'admission';
  let m = /^s(\d+)(Start|End|Seat)$/.exec(key);
  if (m)
    return `${{ Start: 'ss', End: 'se', Seat: 'sr' }[m[2] as 'Start' | 'End' | 'Seat']}${m[1]}`;
  m = /^t(\d+)(Name|Price|Qty|Max)$/.exec(key);
  if (m)
    return `${{ Name: 'tn', Price: 'tp', Qty: 'tq', Max: 'tm' }[m[2] as 'Name' | 'Price' | 'Qty' | 'Max']}${m[1]}`;
  return null;
}

/** The first field to focus for a set of errors, in the order the step shows them. */
export function firstInvalidFieldId(
  errors: FieldErrors,
  categoryMode: 'list' | 'other',
): string | null {
  for (const key of Object.keys(errors)) {
    const id = fieldIdForError(key, categoryMode);
    if (id) return id;
  }
  return null;
}

/**
 * What happens when the organizer presses each button on Review, said before they press it.
 *
 * Read off what the API does, not written as policy: saving leaves the event a DRAFT;
 * submitting checks the event can actually be sold and then either publishes it (an
 * organization an administrator has marked as trusted) or puts it UNDER_REVIEW.
 */
export function whatHappensNext(autoApprove: boolean): {
  saveDraft: string;
  submit: string;
  checks: string;
  /** What the event's status will be after Submit, in the status vocabulary. */
  submitStatus: 'In review' | 'Published';
} {
  return {
    checks:
      'Before an event goes live we check that every ticket can actually be bought. If something would stop a sale, the event stays a draft and its page tells you what to fix.',
    saveDraft:
      'Create draft event creates the event as a draft. Nobody else can see it and no tickets are sold. You can submit it later from its page.',
    submit: autoApprove
      ? 'Submit and publish publishes the event at once, because an administrator has set your organization to publish without a review. Tickets go on sale straight away.'
      : 'Submit for approval sends the event to our team. Its status is In review until then. Tickets go on sale when it is approved, and you are told whether it was.',
    submitStatus: autoApprove ? 'Published' : 'In review',
  };
}

/* ── WHAT THE BUYER WILL SEE ─────────────────────────────────────────────────────── */

/**
 * The lowest price on sale, in minor units, as the customer event card shows it ("From ...").
 *
 * Null when it cannot be known here: reserved seating is priced from the seat map's categories,
 * which this page does not hold, and a paid event with no valid price yet has nothing to show.
 */
export function fromPriceMinor(
  answers: Pick<WizardAnswers, 'admission' | 'sessions' | 'tickets'>,
): number | null {
  if (answers.admission === 'free') return 0;
  if (answers.admission !== 'paid') return null;
  const prices = ticketsToSend(answers)
    .filter((t) => t.priceMajor.trim() !== '')
    .map((t) => Number(t.priceMajor))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (prices.length === 0) return null;
  return Math.round(Math.min(...prices) * 100);
}

/**
 * The one line about fees a buyer reads next to the price, for each way fees can be paid.
 *
 * Read off what checkout does (`calculateFees`): the buyer is charged the booking and payment
 * fees in full, half of them, or none, and on a free event there is no checkout at all.
 */
export function buyerFeeNote(admission: Admission, feeMode: string): string {
  if (admission === 'free') return 'Free to book. No checkout and no fees.';
  if (feeMode === 'ORGANIZER_PAYS') return 'No fees added. The buyer pays the ticket price.';
  if (feeMode === 'SHARED')
    return 'Plus half of the booking and payment fees, shown before the buyer pays.';
  return 'Plus booking and payment fees, shown before the buyer pays.';
}

/* ── THE SAVED DRAFT ──────────────────────────────────────────────────────────────── */

/** Everything the wizard keeps between visits. Images are deliberately not in it. */
export interface WizardDraft {
  /**
   * What the organizer said they are organizing (an id from components/create-event), or ''
   * before they have said. Words and defaults only: nothing sent to the API depends on it.
   */
  experience: string;
  step: number;
  /** The furthest step reached, so the indicator can offer the same jumps after a reload. */
  furthest: number;
  basics: {
    title: string;
    category: string;
    description: string;
    refundPolicy: string;
    refundsEnabled: boolean;
    refundCutoffHours: string;
  };
  details: {
    ageLimit: string;
    artists: EventArtist[];
    termsAndConditions: string;
  };
  categoryMode: 'list' | 'other';
  admission: Admission;
  venueMode: 'existing' | 'new';
  venueId: string;
  newVenue: { name: string; city: string; address: string; capacity: string };
  /** Country, state and clock for a venue created here. Null when the saved value is unusable. */
  newVenueWhere: LocationValue | null;
  feeMode: string;
  sessions: SessionDraft[];
  tickets: TicketDraft[];
}

export function serializeWizardDraft(draft: WizardDraft): string {
  return JSON.stringify(draft);
}

/** What a starter template fills in before the organizer has typed anything. */
export interface WizardSeed {
  experience?: string;
  /** The first ticket row's name - "Standard pass" for a conference. */
  ticketName?: string;
  title?: string;
  category?: string;
  description?: string;
  categoryMode?: 'list' | 'other';
}

/**
 * The wizard as it opens, before anybody has typed anything.
 *
 * One definition, used by the page for its first render AND by the check below for "has this
 * draft got anything in it", so the two cannot disagree about what a blank form is.
 *
 * The first ticket row is "General" with a quantity of 100 and no price: a price typed for the
 * organizer would be in a currency they had not chosen yet, and a number they did not choose is
 * one they may not notice they are publishing.
 */
export function initialWizardDraft(seed: WizardSeed = {}): WizardDraft {
  return {
    experience: seed.experience ?? '',
    step: 0,
    furthest: 0,
    basics: {
      title: seed.title ?? '',
      category: seed.category ?? '',
      description: seed.description ?? '',
      refundPolicy: '',
      /* The platform's existing behaviour, now stated rather than assumed. */
      refundsEnabled: true,
      refundCutoffHours: '48',
    },
    details: { ageLimit: '', artists: [], termsAndConditions: '' },
    categoryMode: seed.categoryMode ?? 'list',
    admission: '',
    venueMode: 'existing',
    venueId: '',
    newVenue: { name: '', city: '', address: '', capacity: '' },
    newVenueWhere: null,
    feeMode: 'CUSTOMER_PAYS',
    sessions: [{ ...EMPTY_SESSION }],
    tickets: [
      {
        sessionIndex: 0,
        name: seed.ticketName ?? 'General',
        priceMajor: '',
        quantityTotal: '100',
        maxPerOrder: '6',
      },
    ],
  };
}

/**
 * Whether a saved draft holds anything the organizer actually entered.
 *
 * ── THE FALSE "PICKED UP WHERE YOU LEFT OFF" ───────────────────────────────────────
 * The page saves on every render, including the very first one, so simply OPENING the wizard
 * wrote a draft of the blank form. The next visit restored it and announced "Picked up where you
 * left off" over a form with nothing in it - a message about work that never happened, which
 * teaches people to ignore the message the one time it matters.
 *
 * A draft counts when any answer differs from the form as it opens. What is left out is what
 * says nothing on its own: which step was showing, the venue tab or the category mode with
 * nothing typed under them, and the new-venue location, which starts from the visitor's own
 * country rather than from anything they chose.
 */
export function isMeaningfulDraft(draft: WizardDraft, initial: WizardDraft): boolean {
  const answers = (d: WizardDraft) =>
    JSON.stringify([
      d.basics,
      d.details,
      d.admission,
      d.venueId,
      d.newVenue,
      d.feeMode,
      d.sessions,
      d.tickets,
    ]);
  return answers(draft) !== answers(initial);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const clampStep = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) ? Math.min(Math.max(v, 0), REVIEW_STEP) : 0;

/**
 * A saved draft, checked, or null when it cannot be trusted.
 *
 * Storage is outside this page's control: an older build, another tab or a hand-edited value
 * can leave anything there. A draft with the wrong shape is refused whole rather than patched
 * field by field - an organizer editing a form half of which they did not fill in is worse off
 * than one starting again. Missing optional parts (details from before they existed) start
 * empty, as the page always did.
 */
export function restoreWizardDraft(raw: unknown): WizardDraft | null {
  const d = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!isObject(d)) return null;
  const b = d.basics;
  if (!isObject(b) || !Array.isArray(d.sessions) || !Array.isArray(d.tickets)) return null;
  if (!isObject(d.newVenue)) return null;
  const sessions: SessionDraft[] = [];
  for (const s of d.sessions) {
    if (!isObject(s)) return null;
    sessions.push({
      startsAt: str(s.startsAt),
      endsAt: str(s.endsAt),
      screenId: str(s.screenId),
      seatMapId: str(s.seatMapId),
    });
  }
  const tickets: TicketDraft[] = [];
  for (const t of d.tickets) {
    if (!isObject(t)) return null;
    tickets.push({
      sessionIndex: typeof t.sessionIndex === 'number' ? t.sessionIndex : 0,
      name: str(t.name),
      priceMajor: str(t.priceMajor),
      quantityTotal: str(t.quantityTotal),
      maxPerOrder: str(t.maxPerOrder, '6'),
    });
  }
  const details = isObject(d.details) ? d.details : {};
  const step = clampStep(d.step);
  const furthest = Math.max(step, clampStep(d.furthest));
  return {
    // Absent on a draft from before the first question existed; the page works it out from
    // the category, which is what the organizer did answer.
    experience: str(d.experience),
    step,
    furthest,
    basics: {
      title: str(b.title),
      category: str(b.category),
      description: str(b.description),
      refundPolicy: str(b.refundPolicy),
      refundsEnabled: typeof b.refundsEnabled === 'boolean' ? b.refundsEnabled : true,
      refundCutoffHours: str(b.refundCutoffHours, '48'),
    },
    details: {
      ageLimit: str(details.ageLimit),
      artists: Array.isArray(details.artists)
        ? details.artists.filter(isObject).map((a) => ({
            name: str(a.name),
            role: str(a.role),
            bio: str(a.bio),
          }))
        : [],
      termsAndConditions: str(details.termsAndConditions),
    },
    categoryMode: d.categoryMode === 'other' ? 'other' : 'list',
    admission: restoreAdmission(d, sessions, furthest),
    venueMode: d.venueMode === 'new' ? 'new' : 'existing',
    venueId: str(d.venueId),
    newVenue: {
      name: str(d.newVenue.name),
      city: str(d.newVenue.city),
      address: str(d.newVenue.address),
      capacity: str(d.newVenue.capacity),
    },
    newVenueWhere: isLocation(d.newVenueWhere) ? d.newVenueWhere : null,
    feeMode: str(d.feeMode, 'CUSTOMER_PAYS'),
    sessions,
    tickets,
  };
}

/**
 * The admission answer of a saved draft, including one saved before the question existed.
 *
 * An older draft said `isFree` and put rooms on sessions; those two facts ARE the answer. A
 * paid general-admission draft from then says nothing either way, so it counts as answered only
 * if the organizer had already got past the tickets step - where, then, paid was the default.
 */
function restoreAdmission(
  d: Record<string, unknown>,
  sessions: SessionDraft[],
  furthest: number,
): Admission {
  if (d.admission === 'free' || d.admission === 'paid' || d.admission === 'seated')
    return d.admission;
  if (d.admission === '') return '';
  if (sessions.some((s) => s.screenId)) return 'seated';
  if (d.isFree === true) return 'free';
  return furthest > TICKETS_STEP ? 'paid' : '';
}

function isLocation(v: unknown): v is LocationValue {
  return (
    isObject(v) &&
    typeof v.country === 'string' &&
    typeof v.region === 'string' &&
    typeof v.timezone === 'string'
  );
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
