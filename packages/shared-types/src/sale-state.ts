/**
 * Is it selling? One answer, in one shape, for every organizer screen.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────
 * Found on QA (2026-10-10, main 5acd4ad). The same Vijayawada show read "Not selling: 1 problem
 * to fix" on the organizer Overview and "Selling" in the cinema workspace drawer, while checkout
 * sold the seat categories that were mapped and refused the one that was not. Four screens
 * worked "selling" out four ways, each from a different mix of the event status, the
 * configuration check and checkout's sale-eligibility rule. Each was internally consistent; together
 * they contradicted each other about one show.
 *
 * So the API now works it out once, from the same facts checkout refuses a cart by, and sends
 * this shape. The screens put it into words with `saleStateLabel` and decide nothing.
 *
 * ── THREE STATES, NOT TWO ─────────────────────────────────────────────────────────
 * A show whose Gold seats sell and whose Standard seats are refused is neither "Selling" nor
 * "Not selling". Calling it "Selling" hides the refusal a buyer will meet; calling it "Not
 * selling" hides the sales it is making. It is PARTIAL, and is never shown as bare "Selling".
 *
 * ── WHAT IS NOT HERE ──────────────────────────────────────────────────────────────
 * No rule about prices, policies or seats. The regulatory refusals arrive already decided by the
 * API's `sessionSaleEligibility` (the function checkout uses); this file only orders them with
 * the other reasons checkout refuses a cart for and folds the answers together. Checkout stays
 * the place a sale is actually allowed or refused.
 */

export type SaleStateKind = 'SELLING' | 'PARTIAL' | 'NOT_SELLING';

/** The refusal codes of checkout's regulatory pricing check, as the API names them. */
export type RegulatorySaleCode =
  | 'NO_PRICING_POLICY'
  | 'PRICING_POLICY_CONFLICT'
  | 'CINEMA_NOT_CLASSIFIED'
  | 'SEAT_CLASS_UNMAPPED'
  | 'PRICE_OVER_CEILING'
  | 'REGULATORY_PRICING_UNRESOLVED';

export type SaleReasonCode =
  | RegulatorySaleCode
  /** Checkout refuses every sale of a suspended organizer. */
  | 'ORGANIZER_SUSPENDED'
  /** The event is not PUBLISHED (draft, in review, paused, sold out, cancelled, ended). */
  | 'EVENT_NOT_PUBLISHED'
  /**
   * The film this cinema listing screens is not published, so the storefront does not list it.
   * The one reason checkout itself does not refuse: nobody can reach checkout for it but by a
   * hand-made request, and "Selling" would tell the operator buyers can find it.
   */
  | 'FILM_NOT_PUBLISHED'
  /** The event has no show still to come. */
  | 'NO_UPCOMING_SESSIONS'
  | 'SESSION_CANCELLED'
  | 'SESSION_PAUSED'
  | 'SESSION_ENDED'
  | 'SESSION_STARTED'
  /** The show has no active ticket type, so there is nothing to put in a cart. */
  | 'NO_TICKET_TYPES'
  /** A ticket type's booking window has not opened. */
  | 'SALES_NOT_STARTED'
  /** A ticket type's booking window has closed. */
  | 'SALES_ENDED'
  /** Every place a ticket type sells is taken. */
  | 'SOLD_OUT'
  /** A free event with a priced ticket type: checkout refuses any cart holding it. */
  | 'FREE_EVENT_HAS_PRICES'
  /** A seated show with no seats laid down: a seat ticket cannot be given a seat. */
  | 'SEATED_SESSION_HAS_NO_SEATS';

export interface SaleReason {
  code: SaleReasonCode;
  /** A few words that complete "Not selling: ..." or "Partly selling: ...". Lower case. */
  text: string;
  /** The organizer's full sentence: what is wrong and, where they can, what to do. */
  message: string;
  /** Who can put it right. A PLATFORM reason never carries a fix path. */
  owner: 'ORGANIZER' | 'PLATFORM';
  /** Where the organizer fixes it, relative to the console. Null when nowhere. */
  fixPath: string | null;
  /** The ticket type or seat category it is about, when it is about one. */
  subject?: string;
  /** Ticket types it closes, on one show. Empty on an event's folded reasons. */
  ticketTypeIds: string[];
  /** How many upcoming shows meet it. 1 on a show's own answer. */
  affectedSessions: number;
}

export interface SessionSaleState {
  sessionId: string;
  eventId: string;
  state: SaleStateKind;
  /** Why something is closed, most important first. Empty exactly when SELLING. */
  reasons: SaleReason[];
  /** Active ticket types a purchase made now would be accepted for. */
  openTicketTypeIds: string[];
  /** Active ticket types it would be refused for. */
  closedTicketTypeIds: string[];
}

export interface EventSaleState {
  eventId: string;
  state: SaleStateKind;
  /** Folded across the upcoming shows, the most widespread first. Empty exactly when SELLING. */
  reasons: SaleReason[];
  /** How the event's upcoming shows split. All zero when the event is not published. */
  sessions: { upcoming: number; selling: number; partial: number; notSelling: number };
}

// ── Words ─────────────────────────────────────────────────────────────────────────

/** The few words for a reason. `place` names the state for the pricing-rule reasons. */
export function saleReasonText(
  code: string,
  opts: { place?: string | null; eventStatus?: string; subject?: string } = {},
): string {
  const place = opts.place?.trim() || 'state';
  switch (code) {
    case 'NO_PRICING_POLICY':
      return `${place} pricing rules not configured`;
    case 'PRICING_POLICY_CONFLICT':
      return `${place} pricing rules need correcting`;
    case 'CINEMA_NOT_CLASSIFIED':
      return 'cinema type not on record';
    case 'SEAT_CLASS_UNMAPPED':
      return 'seat classes not mapped';
    case 'PRICE_OVER_CEILING':
      return 'price outside the permitted range';
    case 'REGULATORY_PRICING_UNRESOLVED':
      return 'pricing not cleared for online sale';
    case 'ORGANIZER_SUSPENDED':
      return 'organizer account suspended';
    case 'EVENT_NOT_PUBLISHED':
      return eventStatusText(opts.eventStatus);
    case 'FILM_NOT_PUBLISHED':
      return 'film not published';
    case 'NO_UPCOMING_SESSIONS':
      return 'no upcoming shows';
    case 'SESSION_CANCELLED':
      return 'show cancelled';
    case 'SESSION_PAUSED':
      return 'sales paused';
    case 'SESSION_ENDED':
      return 'show ended';
    case 'SESSION_STARTED':
      return 'show has started';
    case 'NO_TICKET_TYPES':
      return 'no tickets to sell';
    case 'SALES_NOT_STARTED':
      return 'bookings not open yet';
    case 'SALES_ENDED':
      return 'booking closed';
    case 'SOLD_OUT':
      return opts.subject ? `${opts.subject} sold out` : 'sold out';
    case 'FREE_EVENT_HAS_PRICES':
      return 'free event has priced tickets';
    case 'SEATED_SESSION_HAS_NO_SEATS':
      return 'no seats on the seat map';
    default:
      return 'checkout would refuse it';
  }
}

function eventStatusText(status: string | undefined): string {
  switch (status) {
    case 'DRAFT':
      return 'draft, not submitted';
    case 'UNDER_REVIEW':
      return 'waiting for review';
    case 'PAUSED':
      return 'event paused';
    case 'SOLD_OUT':
      return 'sold out';
    case 'CANCELLED':
      return 'event cancelled';
    case 'COMPLETED':
    case 'ARCHIVED':
      return 'event ended';
    default:
      return 'not published';
  }
}

/**
 * "Selling" | "Partly selling: <reason>" | "Not selling: <reason>". The only three sentences
 * any organizer screen says about whether something sells.
 */
export function saleStateLabel(s: Pick<EventSaleState, 'state' | 'reasons'>): string {
  if (s.state === 'SELLING') return 'Selling';
  const lead = s.reasons[0]?.text;
  if (s.state === 'PARTIAL') return `Partly selling: ${lead ?? 'some tickets are closed'}`;
  return `Not selling: ${lead ?? 'checkout would refuse it'}`;
}

// ── One show ──────────────────────────────────────────────────────────────────────

/** An active ticket type, with what checkout reads of it. */
export interface SaleTicketType {
  id: string;
  name: string;
  priceMinor: number;
  salesStartAt: Date | string | null;
  salesEndAt: Date | string | null;
  /** Sells a standing zone, not a numbered seat. */
  zoned: boolean;
  /** Places not yet sold. Null when the API cannot tell, which is never read as sold out. */
  remaining: number | null;
}

/** A refusal from checkout's regulatory check (`sessionSaleEligibility`), already decided. */
export interface CheckoutBlocker {
  code: string;
  owner: 'ORGANIZER' | 'PLATFORM';
  organizerMessage: string;
  fixPath: string | null;
  subject?: string;
  ticketTypeIds: string[];
}

export interface SessionSaleFacts {
  sessionId: string;
  eventId: string;
  organizationSuspended: boolean;
  eventStatus: string;
  /** The film's catalogue status, for a cinema listing; null or absent for anything else. */
  film?: { id: string; status: string } | null;
  isFree: boolean;
  sessionStatus: string;
  startsAt: Date | string;
  /** The show has a room, so a non-zone ticket needs a seat. */
  seated: boolean;
  /** Seats laid down for the show, any status. */
  seatCount: number;
  /** ACTIVE ticket types only: checkout refuses every other status before it prices. */
  ticketTypes: SaleTicketType[];
  /** What checkout's regulatory check refuses, for these same ticket types. */
  checkoutBlockers: CheckoutBlocker[];
  /** The cinema's state, so a pricing reason can name it. */
  region?: string | null;
}

const time = (d: Date | string) => (typeof d === 'string' ? Date.parse(d) : d.getTime());

const REGULATORY = new Set<string>([
  'NO_PRICING_POLICY',
  'PRICING_POLICY_CONFLICT',
  'CINEMA_NOT_CLASSIFIED',
  'SEAT_CLASS_UNMAPPED',
  'PRICE_OVER_CEILING',
  'REGULATORY_PRICING_UNRESOLVED',
]);

const sessionsPath = (eventId: string) => `/organizer/events/${eventId}/sessions`;

/**
 * Whether a purchase of each ticket type on one show would be accepted now, and why not.
 *
 * In checkout's order: the organizer, the event, the show, then each ticket type on its own -
 * its booking window, the free-event rule, its places, and the regulatory check. A reason found
 * for the whole show closes every ticket type and stops there, as checkout does.
 */
export function sessionSaleState(f: SessionSaleFacts, now: Date): SessionSaleState {
  const allIds = f.ticketTypes.map((t) => t.id);
  const whole = (
    code: SaleReasonCode,
    message: string,
    owner: SaleReason['owner'] = 'ORGANIZER',
    fixPath: string | null = null,
  ): SessionSaleState => ({
    sessionId: f.sessionId,
    eventId: f.eventId,
    state: 'NOT_SELLING',
    reasons: [
      {
        code,
        text: saleReasonText(code, { eventStatus: f.eventStatus }),
        message,
        owner,
        fixPath,
        ticketTypeIds: allIds,
        affectedSessions: 1,
      },
    ],
    openTicketTypeIds: [],
    closedTicketTypeIds: allIds,
  });

  if (f.organizationSuspended)
    return whole(
      'ORGANIZER_SUSPENDED',
      'The platform team has suspended this organizer account, so nothing can be sold. Contact support.',
      'PLATFORM',
    );
  if (f.eventStatus !== 'PUBLISHED')
    return whole(
      'EVENT_NOT_PUBLISHED',
      'Buyers can only book a published event.',
      'ORGANIZER',
      `/organizer/events/${f.eventId}`,
    );
  if (f.film && f.film.status !== 'PUBLISHED')
    return whole(
      'FILM_NOT_PUBLISHED',
      'Buyers cannot find a film until it is published.',
      'ORGANIZER',
      `/organizer/movies/${f.film.id}`,
    );
  if (f.sessionStatus === 'CANCELLED') return whole('SESSION_CANCELLED', 'This show is cancelled.');
  if (f.sessionStatus === 'PAUSED')
    return whole(
      'SESSION_PAUSED',
      'Sales for this show were paused by your team. Existing tickets stay valid.',
      'ORGANIZER',
      sessionsPath(f.eventId),
    );
  if (f.sessionStatus !== 'SCHEDULED') return whole('SESSION_ENDED', 'This show has ended.');
  if (time(f.startsAt) <= now.getTime())
    return whole('SESSION_STARTED', 'Sales close when the show starts.');
  if (f.ticketTypes.length === 0)
    return whole(
      'NO_TICKET_TYPES',
      'This show has no ticket types on sale, so nobody can buy anything for it. Add one.',
      'ORGANIZER',
      sessionsPath(f.eventId),
    );

  const found: SaleReason[] = [];
  const add = (r: Omit<SaleReason, 'text' | 'affectedSessions'>, subject?: string) =>
    found.push({
      ...r,
      ...(subject ? { subject } : {}),
      text: saleReasonText(r.code, { place: f.region, subject }),
      affectedSessions: 1,
    });

  for (const t of f.ticketTypes) {
    const ids = [t.id];
    if (t.salesStartAt && time(t.salesStartAt) > now.getTime()) {
      add({
        code: 'SALES_NOT_STARTED',
        message: `Bookings for ${t.name} have not opened yet.`,
        owner: 'ORGANIZER',
        fixPath: sessionsPath(f.eventId),
        ticketTypeIds: ids,
      });
      continue;
    }
    // Checkout refuses on `salesEndAt < now`, so the close is inclusive.
    if (t.salesEndAt && time(t.salesEndAt) < now.getTime()) {
      add({
        code: 'SALES_ENDED',
        message: `Bookings for ${t.name} have closed.`,
        owner: 'ORGANIZER',
        fixPath: sessionsPath(f.eventId),
        ticketTypeIds: ids,
      });
      continue;
    }
    if (f.isFree && t.priceMinor > 0) {
      add(
        {
          code: 'FREE_EVENT_HAS_PRICES',
          message: `This is a free event, but ${t.name} still carries a price. Set it to zero, or turn off the free-event setting.`,
          owner: 'ORGANIZER',
          fixPath: `/organizer/events/${f.eventId}`,
          ticketTypeIds: ids,
        },
        t.name,
      );
      continue;
    }
    if (f.seated && !t.zoned && f.seatCount === 0) {
      add({
        code: 'SEATED_SESSION_HAS_NO_SEATS',
        message:
          'This show uses a seat map but has no seats on sale. Re-assign the space, or publish a layout with seats in it.',
        owner: 'ORGANIZER',
        fixPath: sessionsPath(f.eventId),
        ticketTypeIds: ids,
      });
      continue;
    }
    if (t.remaining !== null && t.remaining <= 0) {
      add(
        {
          code: 'SOLD_OUT',
          message: `Every place for ${t.name} is taken.`,
          owner: 'ORGANIZER',
          fixPath: null,
          ticketTypeIds: ids,
        },
        t.name,
      );
    }
  }

  // The regulatory refusals, exactly as checkout's own check made them.
  for (const b of f.checkoutBlockers) {
    const known = REGULATORY.has(b.code);
    found.push({
      code: (known ? b.code : 'REGULATORY_PRICING_UNRESOLVED') as SaleReasonCode,
      text: saleReasonText(known ? b.code : 'REGULATORY_PRICING_UNRESOLVED', { place: f.region }),
      message: b.organizerMessage,
      owner: b.owner,
      fixPath: b.owner === 'PLATFORM' ? null : b.fixPath,
      ...(b.subject ? { subject: b.subject } : {}),
      ticketTypeIds: b.ticketTypeIds.filter((id) => allIds.includes(id)),
      affectedSessions: 1,
    });
  }

  const reasons = foldShowReasons(found);
  const closed = new Set(reasons.flatMap((r) => r.ticketTypeIds));
  const open = allIds.filter((id) => !closed.has(id));
  // All sold out is one fact, not a partial sale: say "sold out", not the first category.
  if (open.length === 0 && reasons.every((r) => r.code === 'SOLD_OUT')) {
    for (const r of reasons) r.text = 'sold out';
  }
  return {
    sessionId: f.sessionId,
    eventId: f.eventId,
    state:
      open.length === allIds.length ? 'SELLING' : open.length === 0 ? 'NOT_SELLING' : 'PARTIAL',
    reasons,
    openTicketTypeIds: open,
    closedTicketTypeIds: allIds.filter((id) => closed.has(id)),
  };
}

/** One show's reasons: the same fault met by several ticket types is one fault. */
function foldShowReasons(found: SaleReason[]): SaleReason[] {
  const byKey = new Map<string, SaleReason>();
  for (const r of found) {
    // SOLD_OUT and FREE_EVENT_HAS_PRICES name each ticket type; folded, they name them all.
    const key = [
      r.code,
      r.code === 'SOLD_OUT' || r.code === 'FREE_EVENT_HAS_PRICES' ? '' : r.message,
    ].join('|');
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...r, ticketTypeIds: [...r.ticketTypeIds] });
      continue;
    }
    seen.ticketTypeIds = [...new Set([...seen.ticketTypeIds, ...r.ticketTypeIds])];
    if (r.subject && seen.subject !== r.subject) {
      seen.subject = seen.subject ? `${seen.subject}, ${r.subject}` : r.subject;
      seen.text = saleReasonText(seen.code, { subject: seen.subject });
      if (seen.code === 'SOLD_OUT') seen.message = `Every place for ${seen.subject} is taken.`;
      if (seen.code === 'FREE_EVENT_HAS_PRICES')
        seen.message = `This is a free event, but ${seen.subject} still carry a price. Set them to zero, or turn off the free-event setting.`;
    }
  }
  // The widest fault leads: the one that closes the most of the show explains it best.
  return [...byKey.values()]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.ticketTypeIds.length - a.r.ticketTypeIds.length || a.i - b.i)
    .map(({ r }) => r);
}

// ── One event ─────────────────────────────────────────────────────────────────────

/**
 * An event's state over its upcoming shows (scheduled or paused, not yet started).
 *
 *   - not published, or the organizer suspended -> NOT_SELLING, with that reason
 *   - no upcoming show                          -> NOT_SELLING: no upcoming shows
 *   - every upcoming show SELLING               -> SELLING
 *   - no upcoming show with anything open       -> NOT_SELLING
 *   - anything else                             -> PARTIAL
 *
 * `sessions` are the upcoming shows' own answers from `sessionSaleState`; a show that is not
 * upcoming must not be passed, or a show that played last week would make a live event partial.
 */
export function eventSaleState(input: {
  eventId: string;
  eventStatus: string;
  organizationSuspended: boolean;
  sessions: SessionSaleState[];
}): EventSaleState {
  const none = { upcoming: 0, selling: 0, partial: 0, notSelling: 0 };
  const whole = (
    code: SaleReasonCode,
    message: string,
    owner: SaleReason['owner'],
    fixPath: string | null,
  ): EventSaleState => ({
    eventId: input.eventId,
    state: 'NOT_SELLING',
    reasons: [
      {
        code,
        text: saleReasonText(code, { eventStatus: input.eventStatus }),
        message,
        owner,
        fixPath,
        ticketTypeIds: [],
        affectedSessions: 0,
      },
    ],
    sessions: none,
  });
  if (input.organizationSuspended)
    return whole(
      'ORGANIZER_SUSPENDED',
      'The platform team has suspended this organizer account, so nothing can be sold. Contact support.',
      'PLATFORM',
      null,
    );
  if (input.eventStatus !== 'PUBLISHED')
    return whole(
      'EVENT_NOT_PUBLISHED',
      'Buyers can only book a published event.',
      'ORGANIZER',
      `/organizer/events/${input.eventId}`,
    );

  const shows = input.sessions;
  const counts = {
    upcoming: shows.length,
    selling: shows.filter((s) => s.state === 'SELLING').length,
    partial: shows.filter((s) => s.state === 'PARTIAL').length,
    notSelling: shows.filter((s) => s.state === 'NOT_SELLING').length,
  };
  if (shows.length === 0) {
    const out = whole(
      'NO_UPCOMING_SESSIONS',
      'This event has no show still to come, so there is nothing to sell. Add a date.',
      'ORGANIZER',
      `/organizer/events/${input.eventId}/sessions`,
    );
    return { ...out, sessions: counts };
  }
  if (counts.selling === shows.length)
    return { eventId: input.eventId, state: 'SELLING', reasons: [], sessions: counts };

  const folded = foldSaleStates(shows);
  return { eventId: input.eventId, state: folded.state, reasons: folded.reasons, sessions: counts };
}

/**
 * Several answers folded into one: shows into an event, or a film's cinema listings into the
 * film. All SELLING -> SELLING; none with anything open -> NOT_SELLING; else PARTIAL. An empty
 * list is NOT_SELLING with no reason - the caller says why there was nothing to fold.
 *
 * One fault met in several places is one reason, counted: `affectedSessions` is summed, so
 * a reason carried by two listings of three shows each says six.
 */
export function foldSaleStates(items: Pick<EventSaleState, 'state' | 'reasons'>[]): {
  state: SaleStateKind;
  reasons: SaleReason[];
} {
  const selling = items.filter((s) => s.state === 'SELLING').length;
  const open = items.filter((s) => s.state !== 'NOT_SELLING').length;
  if (items.length > 0 && selling === items.length) return { state: 'SELLING', reasons: [] };
  const byKey = new Map<string, SaleReason>();
  for (const s of items) {
    const seenHere = new Set<string>();
    for (const r of s.reasons) {
      const key = [r.code, r.text, r.message, r.fixPath ?? ''].join('|');
      // The same reason twice on one answer is still one place it was met.
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      const count = Math.max(1, r.affectedSessions);
      const seen = byKey.get(key);
      if (seen) seen.affectedSessions += count;
      else byKey.set(key, { ...r, ticketTypeIds: [], affectedSessions: count });
    }
  }
  const reasons = [...byKey.values()]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.affectedSessions - a.r.affectedSessions || a.i - b.i)
    .map(({ r }) => r);
  return { state: open === 0 ? 'NOT_SELLING' : 'PARTIAL', reasons };
}
