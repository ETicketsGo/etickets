/**
 * What the organizer's event list says about each event beyond its own columns.
 *
 * ── WHY THE LIST CARRIES THIS AT ALL ────────────────────────────────────────────────
 * The list used to return the event row, its venue's name and city, and two counts. Everything
 * an organizer scans a list FOR - when is it on, how full is it, what has it taken - lived only
 * on each event's own pages, so answering "which of my events is selling" meant opening every
 * one of them. The console could have asked each event in turn, but that is one round trip per
 * event on every visit. These are a handful of grouped reads for the whole organization.
 *
 * ── NOTHING HERE IS A NEW FIGURE ────────────────────────────────────────────────────
 * Each number is the one an existing report already defines, so the list and the report it
 * links to cannot disagree:
 *   - sold / capacity: the ticket inventory sums, as the dashboard's capacity block and the
 *     event report's "tickets remaining" read them;
 *   - gross: confirmed bookings' ticket subtotal, per currency, as the dashboard's top events
 *     and the event report read it. Gross only - fees and refunds are on the report, which is
 *     where net is worked out. Currencies are never added together.
 */

/** One currency's confirmed sales for an event. */
export interface OrgEventSales {
  currency: string;
  grossMinor: number;
  bookings: number;
}

/** When an event is on, from its sessions that are not cancelled. */
export interface OrgEventSchedule {
  /** The earliest session, past or future. Null when it has none. */
  firstStartsAt: Date | null;
  /** The latest session. Equal to the first when there is only one. */
  lastStartsAt: Date | null;
  /** The earliest session that has not ended yet - one running now counts. */
  nextStartsAt: Date | null;
  /** Sessions that have not ended yet. */
  upcomingSessions: number;
}

export interface SessionSpan {
  eventId: string;
  _min: { startsAt: Date | null };
  _max: { startsAt: Date | null };
}

export interface UpcomingSpan {
  eventId: string;
  _min: { startsAt: Date | null };
  _count: { _all: number };
}

export interface InventoryTotal {
  eventId: string;
  capacity: number;
  sold: number;
}

export interface SalesGroup {
  eventId: string;
  currency: string;
  _sum: { subtotalMinor: number | null };
  _count: { _all: number };
}

/**
 * Joins the grouped reads onto the events. An event missing from a group simply has none of
 * that thing: no sessions, no inventory, no sales. Sales are null - not empty - when the caller
 * may not see money, so the console can tell "nothing sold" from "not yours to see".
 */
export function assembleOrgEventExtras(
  eventIds: string[],
  reads: {
    spans: SessionSpan[];
    upcoming: UpcomingSpan[];
    inventory: InventoryTotal[];
    sales: SalesGroup[] | null;
  },
): Map<
  string,
  {
    schedule: OrgEventSchedule;
    tickets: { sold: number; capacity: number };
    sales: OrgEventSales[] | null;
  }
> {
  const spans = new Map(reads.spans.map((s) => [s.eventId, s]));
  const upcoming = new Map(reads.upcoming.map((s) => [s.eventId, s]));
  const inventory = new Map(reads.inventory.map((s) => [s.eventId, s]));
  const sales = new Map<string, OrgEventSales[]>();
  for (const g of reads.sales ?? []) {
    const list = sales.get(g.eventId) ?? [];
    list.push({
      currency: g.currency,
      grossMinor: g._sum.subtotalMinor ?? 0,
      bookings: g._count._all,
    });
    sales.set(g.eventId, list);
  }

  return new Map(
    eventIds.map((id) => {
      const span = spans.get(id);
      const next = upcoming.get(id);
      const stock = inventory.get(id);
      return [
        id,
        {
          schedule: {
            firstStartsAt: span?._min.startsAt ?? null,
            lastStartsAt: span?._max.startsAt ?? null,
            nextStartsAt: next?._min.startsAt ?? null,
            upcomingSessions: next?._count._all ?? 0,
          },
          tickets: { sold: stock?.sold ?? 0, capacity: stock?.capacity ?? 0 },
          sales:
            reads.sales === null
              ? null
              : // Largest first, so a card that shows one line shows the one that matters most
                // within its own currency; ties fall back to the currency code to stay stable.
                (sales.get(id) ?? []).sort(
                  (a, b) => b.grossMinor - a.grossMinor || a.currency.localeCompare(b.currency),
                ),
        },
      ];
    }),
  );
}
