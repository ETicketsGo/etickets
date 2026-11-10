import { money, type EventSession, type TicketType } from '@eticketsgo/web-kit';

/*
  The overview's "Tickets and prices" list: what each ticket type costs, how many are sold and
  how many are left, per session. Read from the event the page already loaded - no extra
  request and no sums the server does not already keep.

  Pure, so the grouping and the words are tested as values rather than through a page.
*/

export interface PriceRow {
  id: string;
  name: string;
  /** The price in the ticket's own currency, or "Free". */
  price: string;
  /** False when the ticket type has been switched off (not on sale). */
  active: boolean;
  /** Null when the ticket type has no stock record yet, so nothing can be counted. */
  sold: number | null;
  /** In a basket right now, not yet paid. Null as for `sold`. */
  held: number | null;
  /** Total less sold less held, never below 0. Null as for `sold`. */
  available: number | null;
}

export interface PriceGroup {
  sessionId: string;
  startsAt: string;
  /** The session has finished. Its prices are still shown, after the ones still to come. */
  ended: boolean;
  rows: PriceRow[];
}

export interface PriceList {
  /** The sessions shown, upcoming soonest first, then the ones that have ended. */
  groups: PriceGroup[];
  /** Sessions left out by the cap; the Tickets page lists them all. */
  hiddenSessions: number;
  /** Cancelled sessions, left out because nothing can be sold for them. */
  cancelledSessions: number;
  /** Ticket types across the sessions shown. */
  types: number;
}

/**
 * A ticket's price in words: its own currency through the console's one money formatter, and
 * "Free" for a free event or a price of 0.
 */
export function priceLabel(priceMinor: number, currency: string, eventIsFree: boolean): string {
  if (eventIsFree || priceMinor <= 0) return 'Free';
  return money(priceMinor, currency);
}

/**
 * One ticket type as a row. Sold and held come from its stock record, the same numbers the
 * Tickets page and the event totals read; the total prefers that record and falls back to the
 * ticket type's own quantity.
 */
export function priceRow(t: TicketType, eventIsFree: boolean): PriceRow {
  const inv = t.inventory;
  const total = inv?.quantityTotal ?? t.quantityTotal;
  return {
    id: t.id,
    name: t.name,
    price: priceLabel(t.priceMinor, t.currency, eventIsFree),
    active: t.status === 'ACTIVE',
    sold: inv ? inv.quantitySold : null,
    held: inv ? inv.quantityHeld : null,
    available: inv ? Math.max(0, total - inv.quantitySold - inv.quantityHeld) : null,
  };
}

export const SHOWN_PRICE_SESSIONS = 5;

/**
 * The event's sessions as price lists. Cancelled sessions are counted, not listed. Upcoming
 * sessions come first, soonest first; ended ones follow, latest first. At most `cap` sessions
 * are listed, the rest counted, so a film with fifty shows does not turn the overview into
 * the Tickets page.
 */
export function ticketPriceList(
  sessions: EventSession[],
  opts: { eventIsFree: boolean; now: number; cap?: number },
): PriceList {
  const cap = opts.cap ?? SHOWN_PRICE_SESSIONS;
  const live = sessions.filter((s) => s.status !== 'CANCELLED');
  const cancelledSessions = sessions.length - live.length;
  const ended = (s: EventSession) => new Date(s.endsAt).getTime() <= opts.now;
  const upcoming = live
    .filter((s) => !ended(s))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = live.filter(ended).sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const ordered = [...upcoming, ...past];
  const shown = ordered.slice(0, Math.max(0, cap));
  const groups = shown.map((s) => ({
    sessionId: s.id,
    startsAt: s.startsAt,
    ended: ended(s),
    rows: (s.ticketTypes ?? []).map((t) => priceRow(t, opts.eventIsFree)),
  }));
  return {
    groups,
    hiddenSessions: ordered.length - shown.length,
    cancelledSessions,
    types: groups.reduce((n, g) => n + g.rows.length, 0),
  };
}

/** "12 sold, 30 left", with "2 on hold" when anybody is mid-checkout. */
export function stockLine(row: PriceRow): string {
  if (row.sold === null || row.available === null) return 'Sold and left not counted yet';
  const held = row.held ? `, ${row.held} on hold` : '';
  return `${row.sold} sold, ${row.available} left${held}`;
}
