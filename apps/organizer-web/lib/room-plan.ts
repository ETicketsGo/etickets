/**
 * Turning "about a hundred seats, it's a normal screen" into rows and columns.
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────────────
 * The seat-map form asked for row labels ("A-T") and seats per row. An organizer with a
 * hundred-seat room does not know whether that is A–S, A–Z or A–M, and reported exactly
 * that: they have to work out the arithmetic before they can describe their own cinema,
 * and again for every screen, and again for every venue.
 *
 * They know two things: roughly how big the room is, and what kind of room it is. That is
 * enough — the rest is arithmetic, and arithmetic is what software is for.
 *
 * ── WHY SHAPE MATTERS AND NOT JUST CAPACITY ────────────────────────────────────────
 * A hundred seats is not one layout. In a screening room it is ten rows of ten; in a wide
 * auditorium it is six rows of seventeen. Getting that wrong produces a room that looks
 * nothing like the real one, and the seat map is the thing customers navigate by.
 *
 * So each shape carries an ASPECT: how much wider than deep the seating block is. The
 * planner picks the rows × seats pair closest to that ratio which seats at least as many
 * people as asked for.
 */

/** A kind of room, and how wide it sits relative to its depth. */
export interface RoomShape {
  key: string;
  label: string;
  description: string;
  /** Seats across ÷ rows deep. A cinema is wider than it is deep; a hall is squarer. */
  aspect: number;
  /** What this kind of room usually holds, offered as the starting number. */
  typicalSeats: number;
}

export const ROOM_SHAPES: RoomShape[] = [
  {
    key: 'SCREENING_ROOM',
    label: 'Screening room',
    description: 'A small, intimate room — previews, private hire, boutique cinemas.',
    aspect: 1.4,
    typicalSeats: 40,
  },
  {
    key: 'STANDARD_SCREEN',
    label: 'Standard screen',
    description: 'The ordinary multiplex screen. Wider than it is deep.',
    aspect: 1.8,
    typicalSeats: 150,
  },
  {
    key: 'LARGE_SCREEN',
    label: 'Large screen',
    description: 'A flagship or premium-format screen — wide, with long rows.',
    aspect: 2.3,
    typicalSeats: 320,
  },
  {
    key: 'AUDITORIUM',
    label: 'Auditorium',
    description: 'A single-tier hall for talks, ceremonies and performances.',
    aspect: 2.0,
    typicalSeats: 500,
  },
  {
    key: 'FLAT_HALL',
    label: 'Flat hall',
    description: 'A squarer room with a flat floor — banquets, community halls, classrooms.',
    aspect: 1.1,
    typicalSeats: 120,
  },
];

/**
 * A, B … Z, AA, AB … — row labels that keep working past twenty-six.
 *
 * The old expansion only understood single letters, so a room deeper than twenty-six rows
 * could not be described at all. A large auditorium reaches that easily.
 */
export function rowLabel(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * What one section may hold, straight from the API's own schema.
 *
 * `rowLabels` is capped at 40 entries and `seatsPerRow` at 60, so a single section tops out
 * at 2,400 seats. The planner must respect that: promising an organizer "24 rows of 62" and
 * then failing validation when they press the button is worse than saying up front that the
 * room needs splitting.
 */
export const MAX_ROWS = 40;
export const MAX_SEATS_PER_ROW = 60;
/** Positions in the largest legal section — including the aisle column. */
export const MAX_SECTION_POSITIONS = MAX_ROWS * MAX_SEATS_PER_ROW;
/**
 * SEATS in the largest legal section, which is what an organizer is asking for.
 *
 * One fewer per row than the grid, because a row that wide gets an aisle. Quoting the grid
 * size as the capacity would promise forty seats that are a corridor.
 */
export const MAX_SECTION_SEATS = MAX_ROWS * (MAX_SEATS_PER_ROW - 1);

export interface RoomPlan {
  rows: number;
  /** Positions across, INCLUDING the aisle column when there is one. */
  seatsPerRow: number;
  /** rows × seatsPerRow — positions, not seats. */
  total: number;
  /**
   * Seats somebody can actually buy: the grid minus the aisle running through it.
   *
   * This is the number the organizer asked for, and the number the preview shows. Planning
   * on `total` instead meant a request for 100 produced a 10×10 grid with an aisle down the
   * middle and ninety bookable seats — the headline and the preview disagreeing by a tenth
   * of the room, which is exactly the advertised-versus-real capacity bug this product has
   * already shipped once.
   */
  sellable: number;
  /** Where the suggested aisle goes, or null in a row too narrow to want one. */
  aisle: number | null;
  /** Explicit labels, so a room deeper than Z is expressible. */
  rowLabels: string[];
  /**
   * True when the capacity asked for does not fit in ONE section.
   *
   * The plan returned is then the largest a section can be, and the caller says so rather
   * than silently seating fewer people than were asked for.
   */
  exceedsSection: boolean;
}

/**
 * The rows × seats layout closest to a shape's proportions that seats everybody.
 *
 * ── NEVER FEWER THAN ASKED ─────────────────────────────────────────────────────────
 * Rounding down would quietly sell a smaller room than the organizer described, and the
 * discrepancy would surface as a sold-out show with empty chairs in it. Rounding up at most
 * adds a short final row, which is what a real room does anyway.
 *
 * Candidates are scored on how far the resulting block is from the shape's aspect ratio,
 * with a small penalty for wasted seats, so a 100-seat standard screen comes out as 8 × 13
 * (104) rather than 4 × 25 (100) — both seat everyone, only one looks like a cinema.
 */
export function planRoom(capacity: number, shape: RoomShape): RoomPlan {
  const wanted = Math.max(1, Math.floor(capacity));

  let best: RoomPlan | null = null;
  let bestScore = Infinity;

  const capped = Math.min(wanted, MAX_SECTION_SEATS);

  // Every row count that could plausibly hold the capacity, within what a section allows.
  const maxRows = Math.min(capped, MAX_ROWS);
  for (let rows = 1; rows <= maxRows; rows++) {
    for (let seatsPerRow = 1; seatsPerRow <= MAX_SEATS_PER_ROW; seatsPerRow++) {
      const aisle = suggestedAisle(seatsPerRow);
      // The aisle costs one position per row, so a wide grid seats fewer than it measures.
      const sellable = rows * (seatsPerRow - (aisle === null ? 0 : 1));
      if (sellable < capped) continue;
      const total = rows * seatsPerRow;

      // How far this block's proportions are from the shape's, in log space so that being
      // twice as wide and half as wide are penalised equally.
      const ratio = seatsPerRow / rows;
      const shapeMiss = Math.abs(Math.log(ratio / shape.aspect));
      // Wasted seats matter, but much less than looking like the wrong room.
      const waste = (sellable - capped) / capped;
      const score = shapeMiss + waste * 0.35;

      if (score < bestScore) {
        bestScore = score;
        best = {
          rows,
          seatsPerRow,
          total,
          sellable,
          aisle,
          rowLabels: Array.from({ length: rows }, (_unused, i) => rowLabel(i)),
          // The request, not the capped plan: somebody asking for 5,000 must be told.
          exceedsSection: wanted > MAX_SECTION_SEATS,
        };
      }
      // Wider rows only get worse for this row count once the capacity is met.
      break;
    }
  }

  /*
    The fallback is reachable, and it is the interesting case.

    Above 2,400 the loop finds nothing: every row count leaves more than sixty seats in a
    row. The largest a section can be is the honest answer, flagged so the caller can say
    "split this into sections" rather than quietly seating a third of the audience.
  */
  return (
    best ?? {
      rows: MAX_ROWS,
      seatsPerRow: MAX_SEATS_PER_ROW,
      total: MAX_SECTION_POSITIONS,
      sellable: MAX_SECTION_SEATS,
      aisle: suggestedAisle(MAX_SEATS_PER_ROW),
      rowLabels: Array.from({ length: MAX_ROWS }, (_unused, i) => rowLabel(i)),
      exceedsSection: true,
    }
  );
}

/**
 * A sensible aisle down the middle of a wide room.
 *
 * Returned as a seat POSITION, not written into the plan: an aisle is a choice, and this is
 * only the suggestion the form starts from. Rooms narrower than ten across get none — a gap
 * in an eight-seat row costs a seat and saves nobody a walk.
 */
export function suggestedAisle(seatsPerRow: number): number | null {
  return seatsPerRow >= 10 ? Math.ceil(seatsPerRow / 2) : null;
}
