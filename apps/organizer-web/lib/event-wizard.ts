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
}

/*
  Ordered by what an organizer KNOWS first, not by what the database needs first.

  Everybody starting an event knows what it is called. Most know where and when. Prices come
  next, because a price only means something once there is a venue (it decides the currency)
  and a session (a seated room decides the ticket types). Pictures, performers, terms and the
  refund rule are the things people come back to fill in, so they are last and nothing on that
  step is required.
*/
export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    id: 'basics',
    title: 'Basics',
    intro: 'What the event is called and what kind of event it is.',
    required: 'Required: a title and a category.',
  },
  {
    id: 'where',
    title: 'Where and when',
    intro: 'The venue, and each date and time the event happens.',
    required: 'Required: a venue, and at least one session with a start and an end time.',
  },
  {
    id: 'tickets',
    title: 'Tickets and pricing',
    intro: 'What you sell and for how much. A free event is set here.',
    required:
      'Required: at least one ticket type with a name and a quantity, and a price unless the event is free. Sessions with a seat map need none.',
  },
  {
    id: 'details',
    title: 'Image and details',
    intro: 'Pictures, age limit, performers, terms and refunds. You can change all of these later.',
    required: 'Nothing here is required.',
  },
  {
    id: 'review',
    title: 'Review and create',
    intro: 'Check your answers. Use Edit to change anything.',
    required: 'Nothing is created until you press Save draft or Submit for approval.',
  },
];

export const STEP_COUNT = WIZARD_STEPS.length;
export const REVIEW_STEP = STEP_COUNT - 1;

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

/** The answers the step rules read. The page holds more; none of the rest is required. */
export interface WizardAnswers {
  basics: { title: string; category: string };
  isFree: boolean;
  venueMode: 'existing' | 'new';
  venueId: string;
  newVenue: { name: string; city: string };
  sessions: SessionDraft[];
  tickets: TicketDraft[];
}

export type FieldErrors = Record<string, string>;

export const EMPTY_SESSION: SessionDraft = {
  startsAt: '',
  endsAt: '',
  screenId: '',
  seatMapId: '',
};

/** True when every session is in a room, so the ticket types come from its seat map. */
export function allSessionsSeated(sessions: SessionDraft[]): boolean {
  return sessions.length > 0 && sessions.every((s) => Boolean(s.screenId));
}

/**
 * The ticket rows that will actually be sent.
 *
 * A row pointing at a seated session is dropped on submit - that session's ticket types come
 * from the room's seat categories - so it is neither judged nor shown on Review.
 */
export function ticketsToSend(answers: Pick<WizardAnswers, 'sessions' | 'tickets'>): TicketDraft[] {
  return answers.tickets.filter((t) => !answers.sessions[t.sessionIndex]?.screenId);
}

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
  if (stepId === 'tickets' && !allSessionsSeated(a.sessions)) {
    // Only the tickets that will actually be sent are judged. One left pointing at a
    // session that has since been given a room is dropped on submit, so blocking the
    // organizer on it would be refusing to accept a form because of a field they cannot see.
    if (ticketsToSend(a).length === 0) e.form = 'Add at least one ticket type.';
    a.tickets.forEach((t, i) => {
      if (a.sessions[t.sessionIndex]?.screenId) return;
      if (!t.name.trim()) e[`t${i}Name`] = 'Name is required.';
      if (
        !a.isFree &&
        (t.priceMajor === '' || !Number.isFinite(Number(t.priceMajor)) || Number(t.priceMajor) < 0)
      )
        e[`t${i}Price`] = 'Enter a valid price (0 or more).';
      if (Number(t.quantityTotal) < 1) e[`t${i}Qty`] = 'Quantity must be at least 1.';
    });
  }
  return e;
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
  let m = /^s(\d+)(Start|End)$/.exec(key);
  if (m) return `${m[2] === 'Start' ? 'ss' : 'se'}${m[1]}`;
  m = /^t(\d+)(Name|Price|Qty)$/.exec(key);
  if (m)
    return `${{ Name: 'tn', Price: 'tp', Qty: 'tq' }[m[2] as 'Name' | 'Price' | 'Qty']}${m[1]}`;
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
} {
  return {
    checks:
      'Before an event goes live we check that every ticket can actually be bought. If something would stop a sale, the event stays a draft and its page tells you what to fix.',
    saveDraft:
      'Save draft creates the event as a draft. Nobody else can see it and no tickets are sold. You can submit it later from its page.',
    submit: autoApprove
      ? 'Submit for approval publishes the event at once, because your organization is trusted to publish without a review. Tickets go on sale straight away.'
      : 'Submit for approval sends the event to our team. Tickets go on sale when it is approved, and you are told whether it was.',
  };
}

/* ── THE SAVED DRAFT ──────────────────────────────────────────────────────────────── */

/** Everything the wizard keeps between visits. Images are deliberately not in it. */
export interface WizardDraft {
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
  isFree: boolean;
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
  return {
    step,
    furthest: Math.max(step, clampStep(d.furthest)),
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
    isFree: d.isFree === true,
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
