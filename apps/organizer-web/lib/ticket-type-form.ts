import { experienceForCategory, getExperience } from '../components/create-event/experiences';

/**
 * The words and the rules of the event's "Tickets" page, kept out of the page so they can be
 * tested without rendering it.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The page's "Add ticket type" button stayed greyed out until a session was picked - even when
 * the event HAD only one session - and nothing on the screen said why. An organizer who had
 * just filled in name, price and quantity was left looking at a dead button. The create
 * wizard (#306) also speaks the event's own language ("Performance", "Match", "Pass",
 * "Quantity on sale", "Price (INR, <symbol>)") and this page said "Session" and "Quantity" for every
 * kind of event, so the same thing had two names depending on where you set it up.
 *
 * Nothing here decides what can be sold. The API still refuses what it always refused; these
 * checks only say so before the request instead of after it, in the wizard's words.
 */

export interface TicketWords {
  /** One date and time of the event: "Performance", "Match", "Day", "Session"... */
  session: string;
  /** One kind of ticket: "Ticket type", or "Pass" for a conference. */
  ticket: string;
}

/**
 * The event's own words, from its category - the same table the wizard reads.
 *
 * A category that belongs to no experience falls to "community or other", whose words are the
 * plain "Session" / "Ticket type", which is what this page said before.
 */
export function ticketWords(category: string | null | undefined): TicketWords {
  const experience = getExperience(experienceForCategory(category ?? ''));
  return {
    session: experience?.sessionNoun ?? 'Session',
    ticket: experience?.ticketNoun ?? 'Ticket type',
  };
}

/** "Price (INR, ₹)", or "Price (CAD)" where the symbol is just the code - the wizard's label. */
export function priceLabel(currency: string, symbol: string): string {
  return symbol === currency ? `Price (${currency})` : `Price (${currency}, ${symbol})`;
}

/** "a match", "an opening": for sentences that name one session. */
export function withArticle(noun: string): string {
  const lower = noun.toLowerCase();
  return /^[aeiou]/.test(lower) ? `an ${lower}` : `a ${lower}`;
}

/**
 * Which session the form starts on.
 *
 * With exactly one there is no choice to make, so it is made: asking the organizer to pick
 * the only option is the dead end this page used to be. With several, nothing is guessed -
 * the first one is not more likely than the others, and a ticket type created for the wrong
 * night is sold on the wrong night.
 */
export function initialSessionId(sessions: readonly { id: string }[]): string {
  return sessions.length === 1 ? sessions[0].id : '';
}

/**
 * Whether the selected session is still one of the event's - a session deleted in another tab
 * must not stay selected, or the form would post to a session that no longer exists.
 */
export function resolveSessionId(sessions: readonly { id: string }[], selected: string): string {
  if (selected && sessions.some((s) => s.id === selected)) return selected;
  return initialSessionId(sessions);
}

/**
 * What the add form can do right now, said in words.
 *
 * `no-sessions` - there is nothing to sell a ticket for yet; the page points at Sessions.
 * `choose`      - several sessions and none picked; the reason is shown next to the button, which
 *                 stays pressable and takes the organizer to the picker.
 * `ready`       - a session is chosen; the fields decide the rest.
 */
export type AddFormState =
  | { kind: 'no-sessions'; message: string }
  | { kind: 'choose'; message: string }
  | { kind: 'ready' };

export function addFormState(
  sessions: readonly { id: string }[],
  selected: string,
  words: TicketWords,
): AddFormState {
  const session = words.session.toLowerCase();
  if (sessions.length === 0)
    return {
      kind: 'no-sessions',
      message: `Each ${words.ticket.toLowerCase()} is sold for one ${session}. Add one on the Sessions page, then come back here.`,
    };
  if (!resolveSessionId(sessions, selected))
    return {
      kind: 'choose',
      message: `Select ${withArticle(words.session)} first. Each ${words.ticket.toLowerCase()} is sold for one ${session}, and this event has ${sessions.length}.`,
    };
  return { kind: 'ready' };
}

export interface TicketTypeFields {
  eventSessionId: string;
  name: string;
  priceMajor: string;
  quantityTotal: string;
  maxPerOrder: string;
}

export type TicketTypeErrors = Partial<Record<keyof TicketTypeFields, string>>;

/** The most one buyer can take at once - the API's own limit (createTicketTypeSchema). */
export const MAX_PER_ORDER_LIMIT = 50;

const isWholeNumber = (v: string) => /^\d+$/.test(v.trim());

/**
 * What is wrong with the add form, keyed by field, in the wizard's words.
 *
 * `existingNames` are the ticket types already on the chosen session: two called "General" on
 * the same night are two prices for what a buyer sees as one thing - the wizard refuses that
 * too. Free events have no price to check; the page sends 0, the only price the API accepts
 * for them.
 */
export function validateTicketType(
  f: TicketTypeFields,
  opts: {
    words: TicketWords;
    isFree: boolean;
    existingNames: readonly string[];
    sessionIds: readonly string[];
  },
): TicketTypeErrors {
  const e: TicketTypeErrors = {};
  if (!f.eventSessionId || !opts.sessionIds.includes(f.eventSessionId))
    e.eventSessionId = `Select ${withArticle(opts.words.session)}.`;

  const name = f.name.trim().toLowerCase();
  if (!name) e.name = 'Name is required.';
  else if (opts.existingNames.some((n) => n.trim().toLowerCase() === name))
    e.name = `Another ${opts.words.ticket.toLowerCase()} for this ${opts.words.session.toLowerCase()} has the same name.`;

  if (
    !opts.isFree &&
    (f.priceMajor.trim() === '' ||
      !Number.isFinite(Number(f.priceMajor)) ||
      Number(f.priceMajor) < 0)
  )
    e.priceMajor = 'Enter a valid price (0 or more).';

  // Whole tickets: "1.5" used to pass `> 0` here and was then refused by the API.
  if (!isWholeNumber(f.quantityTotal) || Number(f.quantityTotal) < 1)
    e.quantityTotal = 'Quantity must be a whole number, at least 1.';

  // Blank is allowed and means the default, as it always has.
  if (f.maxPerOrder.trim() !== '') {
    if (!isWholeNumber(f.maxPerOrder) || Number(f.maxPerOrder) < 1)
      e.maxPerOrder = 'Max per order must be a whole number, at least 1.';
    else if (Number(f.maxPerOrder) > MAX_PER_ORDER_LIMIT)
      e.maxPerOrder = `Max per order can be at most ${MAX_PER_ORDER_LIMIT}.`;
    else if (!e.quantityTotal && Number(f.maxPerOrder) > Number(f.quantityTotal))
      e.maxPerOrder = 'Max per order cannot be more than the quantity on sale.';
  }
  return e;
}

/** The fields in the order the form shows them: the first with a problem gets the focus. */
export const FIELD_ORDER: readonly (keyof TicketTypeFields)[] = [
  'eventSessionId',
  'name',
  'priceMajor',
  'quantityTotal',
  'maxPerOrder',
];

export function firstInvalidField(errors: TicketTypeErrors): keyof TicketTypeFields | null {
  return FIELD_ORDER.find((k) => errors[k]) ?? null;
}

/**
 * What is wrong with the edit dialog. Same words as the add form; the extra rule is the one the
 * API already enforces after a sale - the quantity cannot drop below what is sold or held -
 * said under the field instead of as an error toast after Save.
 */
export function validateTicketTypeEdit(
  f: Omit<TicketTypeFields, 'eventSessionId'>,
  opts: { isFree: boolean; priceLocked: boolean; committed: number },
): TicketTypeErrors {
  const e: TicketTypeErrors = {};
  if (!f.name.trim()) e.name = 'Name is required.';
  if (
    !opts.isFree &&
    !opts.priceLocked &&
    (f.priceMajor.trim() === '' ||
      !Number.isFinite(Number(f.priceMajor)) ||
      Number(f.priceMajor) < 0)
  )
    e.priceMajor = 'Enter a valid price (0 or more).';
  if (!isWholeNumber(f.quantityTotal) || Number(f.quantityTotal) < 1)
    e.quantityTotal = 'Quantity must be a whole number, at least 1.';
  else if (Number(f.quantityTotal) < opts.committed)
    e.quantityTotal = `Quantity cannot be less than the ${opts.committed} already sold or held.`;
  if (f.maxPerOrder.trim() !== '') {
    if (!isWholeNumber(f.maxPerOrder) || Number(f.maxPerOrder) < 1)
      e.maxPerOrder = 'Max per order must be a whole number, at least 1.';
    else if (Number(f.maxPerOrder) > MAX_PER_ORDER_LIMIT)
      e.maxPerOrder = `Max per order can be at most ${MAX_PER_ORDER_LIMIT}.`;
  }
  return e;
}

/** "ticket types", "passes": for "No passes yet." */
export function pluralOf(noun: string): string {
  const lower = noun.toLowerCase();
  return /(s|x|ch|sh)$/.test(lower) ? `${lower}es` : `${lower}s`;
}
