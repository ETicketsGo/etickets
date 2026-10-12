/**
 * Whether there is anything left to buy, said once for the whole event page.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * A fully sold-out event said "Sold out" only inside each ticket row. Above and below the rows
 * the page looked like any other: a price breakdown, a guest form and a "Continue to payment"
 * button, none of which could do anything. A buyer who scrolled past the rows saw a page that
 * was asking them to pay for something that was gone.
 *
 * Only `available` decides this. A closed or not-yet-open ticket type is not sold out - it will
 * (or did) have tickets - so it never counts here, and an event with no ticket types at all is
 * not "sold out" either: nothing was ever for sale.
 */

type Stock = { available: number };
type Show = { startsAt: string; ticketTypes: Stock[] };

/** True when the show has ticket types and every one of them is out of stock. */
export function showIsSoldOut(show: { ticketTypes: Stock[] } | undefined): boolean {
  return Boolean(
    show && show.ticketTypes.length > 0 && show.ticketTypes.every((t) => t.available <= 0),
  );
}

/**
 * True when every date that has not started is sold out, so a different date will not help.
 * Dates that have started are not for sale and are ignored.
 */
export function eventIsSoldOut(shows: Show[], now: number = Date.now()): boolean {
  const upcoming = shows.filter((show) => new Date(show.startsAt).getTime() > now);
  return upcoming.length > 0 && upcoming.every((show) => showIsSoldOut(show));
}
