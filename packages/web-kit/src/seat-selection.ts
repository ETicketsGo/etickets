/**
 * How a tap on the storefront's seat map changes the selection — pure, so the rules can be
 * tested without rendering a page.
 *
 * ── THE TWO WAYS TO PICK ───────────────────────────────────────────────────────────
 * Without a ticket count, a tap toggles one seat, exactly as the map always behaved. With a
 * count ("2 tickets"), a tap fills the rest of that count from the tapped seat along its row —
 * the quick pick BookMyShow made familiar — and once the count is met, the next tap places the
 * whole group again from there. Nobody is forced through a "how many seats?" dialog first.
 */

export interface SelectableSeat {
  id: string;
  /** Position in the row. A jump of more than one is an aisle. */
  colIndex: number;
  categoryId: string;
  status: string;
  /** SEAT, WHEELCHAIR or COMPANION. Absent is an ordinary seat. */
  kind?: string;
}

/** The most seats one booking may take. The API caps per ticket type as well. */
export const MAX_SEATS_PER_BOOKING = 10;

const ACCESSIBLE_KINDS = new Set(['WHEELCHAIR', 'COMPANION']);

const byPosition = (a: SelectableSeat, b: SelectableSeat) => a.colIndex - b.colIndex;

/**
 * Whether `next` may join a group that `from` is already in.
 *
 * Never across an aisle, never across a price (a different category is a different ticket),
 * and never from an ordinary seat onto a wheelchair space or companion seat: a quick pick of
 * "4 tickets" next to a wheelchair bay would otherwise take it from the person it exists for.
 * A group started ON an accessible seat may extend onto its neighbouring accessible seats — a
 * wheelchair user booking with their companion.
 */
function canJoin(from: SelectableSeat, next: SelectableSeat, exclude: ReadonlySet<string>) {
  if (Math.abs(next.colIndex - from.colIndex) !== 1) return false;
  if (next.categoryId !== from.categoryId) return false;
  if (next.status !== 'AVAILABLE' || exclude.has(next.id)) return false;
  return ACCESSIBLE_KINDS.has(from.kind ?? '') === ACCESSIBLE_KINDS.has(next.kind ?? '');
}

/**
 * Up to `count` adjacent available seats in one row, starting from the seat the buyer tapped.
 *
 * Extends to the right first, then to the left, and stops at anything `canJoin` refuses.
 * Returns fewer than `count` when the run is shorter — the buyer taps again for the rest —
 * and nothing when the tapped seat itself cannot be taken. Seats in `exclude` (the buyer's own
 * current selection) are treated as taken.
 */
export function pickAdjacentSeats(
  row: readonly SelectableSeat[],
  anchorId: string,
  count: number,
  exclude: ReadonlySet<string> = new Set(),
): string[] {
  const seats = [...row].sort(byPosition);
  const at = seats.findIndex((seat) => seat.id === anchorId);
  if (at < 0 || count <= 0) return [];
  const anchor = seats[at];
  if (anchor.status !== 'AVAILABLE' || exclude.has(anchor.id)) return [];

  const taken = [anchor];
  let right = at;
  while (taken.length < count && right + 1 < seats.length) {
    if (!canJoin(seats[right], seats[right + 1], exclude)) break;
    taken.push(seats[++right]);
  }
  let left = at;
  while (taken.length < count && left - 1 >= 0) {
    if (!canJoin(seats[left], seats[left - 1], exclude)) break;
    taken.push(seats[--left]);
  }
  return taken.sort(byPosition).map((seat) => seat.id);
}

export interface SeatTapResult {
  selected: string[];
  /** The tap asked for more seats than one booking may take, and nothing changed. */
  limitReached: boolean;
}

/**
 * The selection after a tap on `seatId`, which sits in `row`.
 *
 * A tap on a seat already chosen always releases just that seat. A tap on a seat that cannot be
 * sold changes nothing.
 */
export function applySeatTap(args: {
  selected: readonly string[];
  row: readonly SelectableSeat[];
  seatId: string;
  /** The ticket count the buyer chose, or null to pick seat by seat. */
  quantity: number | null;
  max?: number;
}): SeatTapResult {
  const { selected, row, seatId, quantity } = args;
  const max = args.max ?? MAX_SEATS_PER_BOOKING;
  const seat = row.find((candidate) => candidate.id === seatId);
  const unchanged = { selected: [...selected], limitReached: false };
  if (!seat) return unchanged;
  if (selected.includes(seatId)) {
    return { selected: selected.filter((id) => id !== seatId), limitReached: false };
  }
  if (seat.status !== 'AVAILABLE') return unchanged;

  if (quantity === null) {
    if (selected.length >= max) return { selected: [...selected], limitReached: true };
    return { selected: [...selected, seatId], limitReached: false };
  }

  const target = Math.min(quantity, max);
  // The group is complete: this tap places it again, from here.
  if (selected.length >= target) {
    return { selected: pickAdjacentSeats(row, seatId, target), limitReached: false };
  }
  const added = pickAdjacentSeats(row, seatId, target - selected.length, new Set(selected));
  return { selected: [...selected, ...added], limitReached: false };
}

/**
 * Available seats a selection would leave stranded: one seat on its own, wedged between the
 * buyer's seats and something it cannot be sold with — another taken seat, an aisle, the end of
 * the row, or a different price.
 *
 * Nobody books one seat between strangers, so a cinema loses that seat for the whole show. The
 * page suggests shifting along before the buyer pays; it never refuses the booking.
 */
export function strandedSeats(
  row: readonly SelectableSeat[],
  selected: ReadonlySet<string>,
): string[] {
  const seats = [...row].sort(byPosition);
  const stranded: string[] = [];
  seats.forEach((seat, index) => {
    if (seat.status !== 'AVAILABLE' || selected.has(seat.id)) return;
    const sides = [seats[index - 1], seats[index + 1]];
    // A side is closed when nothing sellable-with-this-seat sits right next to it.
    const closed = sides.map(
      (side) =>
        !side ||
        Math.abs(side.colIndex - seat.colIndex) !== 1 ||
        side.categoryId !== seat.categoryId ||
        side.status !== 'AVAILABLE' ||
        selected.has(side.id),
    );
    const causedBySelection = sides.some((side) => side && selected.has(side.id));
    if (closed[0] && closed[1] && causedBySelection) stranded.push(seat.id);
  });
  return stranded;
}

/**
 * What the basket calls a group of chosen seats.
 *
 * ── WHY NOT THE CATEGORY'S NAME ────────────────────────────────────────────────────
 * A seat belongs to a block of the room (the section: "Balcony") and is sold at a price category
 * ("Premium"). The map heads each block with the section's name; the basket used to use the
 * category's, so a buyer who tapped three seats under "BALCONY" was told they had chosen
 * "Premium" — reported by the owner as confusing, which it is. The basket now names the block
 * they saw, and adds the category only when its name says something the block's does not (it is
 * what the ticket and Review & pay will call it). Where a cinema names both the same, one name.
 */
export function seatGroupName(
  sectionNames: readonly string[],
  categoryName: string | null | undefined,
): { title: string; category: string | null } {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const blocks: string[] = [];
  for (const name of sectionNames) {
    if (name.trim() && !blocks.some((block) => same(block, name))) blocks.push(name.trim());
  }
  const category = categoryName?.trim() || null;
  return {
    title: blocks.join(', ') || category || '',
    category:
      category && blocks.length > 0 && !blocks.some((block) => same(block, category))
        ? category
        : null,
  };
}

export type SeatDirection = 'left' | 'right' | 'up' | 'down';

/**
 * The seat arrow-key navigation should move to, or null at an edge.
 *
 * Left and right step along the row. Up and down go to the nearest row that has seats, landing
 * on the seat closest in position — rows are rarely the same width, and an aisle in one row is
 * not an aisle in the next.
 */
export function seatInDirection(
  rows: readonly { seats: readonly SelectableSeat[] }[],
  from: { rowIndex: number; seatId: string },
  direction: SeatDirection,
): { rowIndex: number; seatId: string } | null {
  const current = rows[from.rowIndex] ? [...rows[from.rowIndex].seats].sort(byPosition) : [];
  const at = current.findIndex((seat) => seat.id === from.seatId);
  if (at < 0) return null;

  if (direction === 'left' || direction === 'right') {
    const next = current[direction === 'left' ? at - 1 : at + 1];
    return next ? { rowIndex: from.rowIndex, seatId: next.id } : null;
  }

  const step = direction === 'up' ? -1 : 1;
  for (let r = from.rowIndex + step; r >= 0 && r < rows.length; r += step) {
    if (rows[r].seats.length === 0) continue;
    const target = current[at].colIndex;
    const nearest = [...rows[r].seats].sort(
      (a, b) => Math.abs(a.colIndex - target) - Math.abs(b.colIndex - target) || byPosition(a, b),
    )[0];
    return { rowIndex: r, seatId: nearest.id };
  }
  return null;
}
