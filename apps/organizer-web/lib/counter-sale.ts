import type { CounterShow as WebKitCounterShow, SeatLayout } from '@eticketsgo/web-kit';

/**
 * The counter's sale form, as pure rules: what a cart costs, whether it can be sold, and which
 * seats to give a walk-up buyer on a seated show.
 */

export type CounterShow = WebKitCounterShow;
export type CounterTicketType = CounterShow['ticketTypes'][number];

export type Quantities = Record<string, number>;

/** Total of the tickets chosen, in minor units. Fees are the server's; this is the face value. */
export function cartSubtotal(show: CounterShow | undefined, qty: Quantities): number {
  if (!show) return 0;
  return show.ticketTypes.reduce((sum, t) => sum + t.priceMinor * (qty[t.id] ?? 0), 0);
}

export function ticketCount(qty: Quantities): number {
  return Object.values(qty).reduce((n, q) => n + (q > 0 ? q : 0), 0);
}

/** The most of one ticket type the counter may add: the per-order cap, or what is left. */
export function maxFor(t: CounterTicketType): number {
  return Math.max(0, Math.min(t.maxPerOrder, t.left ?? t.maxPerOrder));
}

/**
 * Seats for a walk-up buyer: `count` seats side by side in one row of `categoryId`, never
 * across an aisle, never a wheelchair space or companion seat (those are given on request,
 * by the seat map, not by a quick sale). Rows are tried in the order the map lists them, so
 * the first block found is the one nearest the stage or screen. `exclude` holds seats already
 * given to another line of the same sale.
 *
 * Null when no row has that many together: the counter says so rather than splitting a group.
 */
export function bestSeats(
  layout: SeatLayout,
  categoryId: string,
  count: number,
  exclude: ReadonlySet<string> = new Set(),
): { ids: string[]; labels: string[] } | null {
  if (count <= 0) return { ids: [], labels: [] };
  for (const section of layout.sections) {
    for (const row of section.rows) {
      const seats = [...row.seats].sort((a, b) => a.colIndex - b.colIndex);
      let run: typeof seats = [];
      for (const seat of seats) {
        const free =
          seat.categoryId === categoryId &&
          seat.status === 'AVAILABLE' &&
          (seat.kind ?? 'SEAT') === 'SEAT' &&
          !exclude.has(seat.id);
        const adjacent = run.length === 0 || seat.colIndex - run[run.length - 1].colIndex === 1;
        if (free && adjacent) run.push(seat);
        else run = free ? [seat] : [];
        if (run.length === count) {
          // Named as the ticket prints them: the row and the seat ("A12"), not the seat alone.
          return { ids: run.map((s) => s.id), labels: run.map((s) => `${row.label}${s.label}`) };
        }
      }
    }
  }
  return null;
}
