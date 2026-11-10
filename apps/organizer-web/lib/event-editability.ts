/**
 * What an organizer may change on an EXISTING event right now, and why not when they may not.
 *
 * -- WHY THIS EXISTS ----------------------------------------------------------------
 * The owner found editing an event confusing: controls appeared and disappeared with no word
 * of explanation. "Change time" on the Sessions page simply vanished once a ticket sold, the
 * free/paid switch went grey for some refusals and failed on Save for others, and the edit
 * page said nothing about dates and tickets staying changeable while the details were locked.
 * Each of those followed a real server rule; none of them said so.
 *
 * -- THE SERVER RULES THIS MIRRORS (it grants nothing; every request is still checked) --
 * - Event details: `EventsService.update` accepts DRAFT, UNDER_REVIEW and PAUSED only. A
 *   PAUSED event whose reviewed details change is marked `needsReviewOnResume`, and resuming
 *   sends it to review unless the organization is trusted to auto-approve.
 * - Free/paid: refused while confirmed/refunded bookings, payments, receipts, refunds or a
 *   live checkout exist (`freeSwitchBlocker`), and turning free on is refused while any
 *   ticket type has a price.
 * - A date's time: `evaluateOperation('EDIT_TIME')` refuses a cancelled, finished or started
 *   date, and one with paid bookings or a checkout in progress.
 * - A ticket type's price: refused once any ticket of that type has sold. A booking stores
 *   the unit price it was quoted (`BookingItem.unitPriceMinor`), so a buyer already checking
 *   out keeps the price they were shown.
 * - Dates and ticket types are not gated on the event's status: they can change while the
 *   event is on sale, under their own rules above.
 *
 * Pure, so each answer is provable in a test. Copy is ASCII-only plain language.
 */

export type EditKind = 'editable' | 'review' | 'locked';

export interface Editability {
  kind: EditKind;
  /** One or two sentences: why, and what to do instead when there is a way. */
  note: string;
}

/** Short words for the badge beside a section heading. */
export function editLabel(kind: EditKind): string {
  if (kind === 'editable') return 'Editable now';
  if (kind === 'review') return 'Editable, then reviewed';
  return 'Locked';
}

const editable = (note: string): Editability => ({ kind: 'editable', note });
const review = (note: string): Editability => ({ kind: 'review', note });
const locked = (note: string): Editability => ({ kind: 'locked', note });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The roles the API lets change an event. A missing role is a platform admin or an older API. */
export function canEditEvents(role: string | null | undefined): boolean {
  if (role == null) return true;
  return role === 'ORGANIZER_OWNER' || role === 'ORGANIZER_MANAGER';
}

export const ROLE_LOCK_NOTE =
  'Only an owner or a manager of this organization can change this event.';

/**
 * The event's own details: title, description, what buyers should know, refunds, free or
 * paid, who pays the fee, tax. One answer, because the server applies one rule to them all.
 */
export function eventDetailsEditability(input: {
  status: string;
  canEdit: boolean;
  /** Reviewed details already changed while paused. */
  needsReviewOnResume?: boolean;
  /** Paused by the platform team, so only they can resume it. */
  pausedByAdmin?: boolean;
}): Editability {
  if (!input.canEdit) return locked(ROLE_LOCK_NOTE);
  switch (input.status) {
    case 'DRAFT':
      return editable(
        'This is a draft and nothing is on sale. Our team reviews it when you submit it.',
      );
    case 'UNDER_REVIEW':
      return editable('Our team is reviewing this event. What you save now is what they review.');
    case 'PAUSED': {
      const resume = input.pausedByAdmin
        ? 'Our team paused this event, so only they can resume it.'
        : 'Sales are paused.';
      return review(
        input.needsReviewOnResume
          ? `${resume} You already changed reviewed details, so when sales resume our team may review them before it sells again.`
          : `${resume} If you change these details, the event may go back to our team for review before it sells again.`,
      );
    }
    case 'PUBLISHED':
      return locked(
        'This event is on sale, so its details are locked. Pause sales to change them. Dates and tickets can still change on their own pages.',
      );
    case 'SOLD_OUT':
      return locked(
        'This event is sold out, so its details are locked. Dates and tickets can still change on their own pages.',
      );
    case 'CANCELLED':
      return locked('This event is cancelled, so its details can no longer change.');
    case 'COMPLETED':
      return locked('This event is over, so its details can no longer change.');
    case 'ARCHIVED':
      return locked('This event is archived, so its details can no longer change.');
    default:
      return locked(
        `This event is ${input.status.toLowerCase().replaceAll('_', ' ')}, so its details cannot change.`,
      );
  }
}

/** Images save on their own and skip review; only a finished event locks them. */
export function imagesEditability(input: { status: string; canEdit: boolean }): Editability {
  if (!input.canEdit) return locked(ROLE_LOCK_NOTE);
  if (['CANCELLED', 'COMPLETED', 'ARCHIVED'].includes(input.status)) {
    const words = input.status === 'COMPLETED' ? 'over' : input.status.toLowerCase();
    return locked(`This event is ${words}, so its images can no longer change.`);
  }
  return editable('Images save as soon as you change them and do not go to review.');
}

/** What is sold and held across the whole event, and how many ticket types carry a price. */
export interface EventSalesFacts {
  sold: number;
  held: number;
  pricedTicketTypes: number;
}

interface TicketLike {
  priceMinor: number;
  inventory?: { quantitySold: number; quantityHeld: number } | null;
}

export function eventSalesFacts(sessions: { ticketTypes?: TicketLike[] }[]): EventSalesFacts {
  let sold = 0;
  let held = 0;
  let pricedTicketTypes = 0;
  for (const s of sessions) {
    for (const t of s.ticketTypes ?? []) {
      sold += t.inventory?.quantitySold ?? 0;
      held += t.inventory?.quantityHeld ?? 0;
      if (t.priceMinor !== 0) pricedTicketTypes += 1;
    }
  }
  return { sold, held, pricedTicketTypes };
}

const OTHER_WAY = 'To sell it the other way, add a new event.';

/**
 * The free/paid switch. Never offered where `EventsService.update` would refuse it; where the
 * page cannot see everything the server counts (a refund on a cancelled booking), it says so.
 */
export function freePaidEditability(input: {
  details: Editability;
  isFree: boolean;
  facts: EventSalesFacts;
  /** Bookings of any status, cancelled and expired included (`_count.bookings`). */
  bookingsOnFile: number;
}): Editability {
  const { details, isFree, facts, bookingsOnFile } = input;
  if (details.kind === 'locked') return details;
  if (facts.sold > 0)
    return locked(
      `${plural(facts.sold, 'ticket has', 'tickets have')} been sold, so this event cannot be switched between free and paid. ${OTHER_WAY}`,
    );
  if (facts.held > 0)
    return locked(
      `${plural(facts.held, 'ticket is', 'tickets are')} held by buyers checking out right now, so this cannot change yet. Try again when those checkouts end.`,
    );
  if (!isFree && facts.pricedTicketTypes > 0)
    return locked(
      `To make this event free, first set ${facts.pricedTicketTypes === 1 ? 'the priced ticket type' : `all ${facts.pricedTicketTypes} priced ticket types`} to zero on the Tickets page.`,
    );
  if (bookingsOnFile > 0)
    return {
      kind: details.kind,
      note: 'Earlier bookings were cancelled or expired. If a payment, receipt or refund is still on file for one of them, saving this switch is refused and the reason is shown.',
    };
  return {
    kind: details.kind,
    note: isFree
      ? 'Nobody is charged: no checkout, no booking fee. Turn this off to charge for tickets.'
      : 'Nobody has booked yet, so you can still make this event free.',
  };
}

/** Changing an existing ticket type's price. */
export function ticketPriceEditability(input: {
  isFree: boolean;
  sold: number;
  held: number;
}): Editability {
  if (input.isFree) return locked('This is a free event, so every ticket is priced at zero.');
  if (input.sold > 0)
    return locked(
      `Price locked: ${plural(input.sold, 'ticket', 'tickets')} sold at this price. To charge a different price, add a new ticket type and deactivate this one.`,
    );
  if (input.held > 0)
    return editable(
      `${plural(input.held, 'ticket is', 'tickets are')} in a checkout now. Those buyers keep the price they were shown; a new price applies to new checkouts only.`,
    );
  return editable('Nothing sold yet, so the price can change.');
}

/** Moving a date to a new time. */
export interface SessionTimeInput {
  status: string;
  startsAt: string;
  endsAt: string;
  sold: number;
  held: number;
}

export function sessionTimeEditability(
  session: SessionTimeInput,
  now: number,
  isFree: boolean,
): Editability {
  if (session.status === 'CANCELLED') return locked('This session is cancelled.');
  if (session.status === 'COMPLETED' || new Date(session.endsAt).getTime() <= now)
    return locked('This session is over.');
  if (new Date(session.startsAt).getTime() <= now)
    return locked('This session has already started, so its time cannot change.');
  if (session.sold > 0)
    return locked(
      `Time locked: ${plural(session.sold, 'ticket', 'tickets')} sold. Buyers chose this time. To move it, cancel this session (${isFree ? 'attendees are told' : 'buyers are refunded and told'}) and add a new one.`,
    );
  if (session.held > 0)
    return locked(
      `Time locked for now: ${plural(session.held, 'ticket is', 'tickets are')} in a checkout. Try again when that checkout ends.`,
    );
  return editable('Nobody has booked this session yet, so its time can change.');
}

/** One line for the edit page about the event's dates. */
export function datesSummary(
  sessions: SessionTimeInput[],
  now: number,
  isFree: boolean,
): Editability {
  if (sessions.length === 0) return editable('No dates yet. Add one before anything can sell.');
  const verdicts = sessions.map((s) => sessionTimeEditability(s, now, isFree));
  const movable = verdicts.filter((v) => v.kind === 'editable').length;
  const total = plural(sessions.length, 'date', 'dates');
  if (movable === sessions.length)
    return editable(`${total}. Nobody has booked any of them, so each can still move.`);
  return editable(
    `${total}. ${movable} can still move; the rest are booked, started or over, and the Sessions page says why for each. You can always add a date.`,
  );
}
