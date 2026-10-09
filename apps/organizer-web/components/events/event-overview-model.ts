import type { EventSession } from '@eticketsgo/web-kit';

/**
 * The event overview's figures, read from the event the page already loaded. Pure, so the
 * counting is tested as values rather than through a rendered page.
 */

export interface TicketTotals {
  /** Every ticket type's stock added up: what could be sold across all sessions. */
  capacity: number;
  sold: number;
  /** In somebody's basket right now, not yet paid. */
  held: number;
  /** Ticket types across all sessions. */
  types: number;
}

/**
 * Sold, held and capacity across every session, from the ticket inventory - the same rows and
 * the same sums the events list and the dashboard's capacity block read, so the three agree.
 * A ticket type with no inventory row has nothing on sale and adds nothing.
 */
export function ticketTotals(sessions: EventSession[]): TicketTotals {
  let capacity = 0;
  let sold = 0;
  let held = 0;
  let types = 0;
  for (const s of sessions) {
    for (const t of s.ticketTypes ?? []) {
      types += 1;
      capacity += t.inventory?.quantityTotal ?? 0;
      sold += t.inventory?.quantitySold ?? 0;
      held += t.inventory?.quantityHeld ?? 0;
    }
  }
  return { capacity, sold, held, types };
}

export interface SessionBreakdown {
  /** Not cancelled and not yet ended, soonest first - one running now included. */
  upcoming: EventSession[];
  past: number;
  cancelled: number;
}

/** The sessions split the way an organizer asks about them: what is coming, what is done. */
export function sessionBreakdown(sessions: EventSession[], now: number): SessionBreakdown {
  const upcoming: EventSession[] = [];
  let past = 0;
  let cancelled = 0;
  for (const s of sessions) {
    if (s.status === 'CANCELLED') cancelled += 1;
    else if (new Date(s.endsAt).getTime() > now) upcoming.push(s);
    else past += 1;
  }
  upcoming.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { upcoming, past, cancelled };
}

/**
 * Whether a description is long enough to fold behind "Read more".
 *
 * By characters and by lines, because either makes a wall: one 900-character paragraph, or a
 * set list typed one song per line. Folding a short one would hide nothing and still cost a
 * click.
 */
export function isLongText(text: string | null | undefined, chars = 320, lines = 5): boolean {
  if (!text) return false;
  return text.length > chars || text.split('\n').length > lines;
}
