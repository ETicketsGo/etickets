/**
 * Turning what an operator types into a seat layout.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The generator asked for row labels as a comma-separated list. That is fine for a
 * four-row screening room and unusable for a real auditorium: a 250-seat house is twenty
 * rows, and "A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T" typed by hand is both miserable and
 * easy to get wrong in a way nobody notices until seats are missing.
 *
 * So ranges are accepted — `A-T` means the twenty rows from A to T — and the same parsing
 * is reused for seat positions, where `1-4, 19-20` is the natural way to say which seats in
 * a row are a wheelchair bay.
 *
 * Pure and shared on purpose: the live preview and the request body are produced by the
 * same functions, so what the operator is shown cannot drift from what is created.
 */

/** Letters used for row ranges, in order. Rows beyond Z are written out explicitly. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Expand a row specification into ordered, de-duplicated labels.
 *
 * Accepts a mixture: `A-F` (a range), `AA` (a literal), and any combination separated by
 * commas — `A-D, AA, BB`. Ranges only apply between single letters, because "A1-B7" has no
 * unambiguous meaning and guessing at one would produce a room nobody asked for.
 */
export function expandRowLabels(input: string): string[] {
  const out: string[] = [];
  for (const rawPart of input.split(',')) {
    const part = rawPart.trim().toUpperCase();
    if (!part) continue;

    const range = /^([A-Z])\s*-\s*([A-Z])$/.exec(part);
    if (range) {
      const from = ALPHABET.indexOf(range[1]);
      const to = ALPHABET.indexOf(range[2]);
      // A descending range is a typo, not an instruction to reverse the room.
      if (from === -1 || to === -1 || to < from) continue;
      for (let i = from; i <= to; i++) out.push(ALPHABET[i]);
      continue;
    }
    out.push(part);
  }
  // De-duplicated because two rows sharing a label collide on the (row, label) unique index
  // and would fail the whole generation with a database error rather than a readable one.
  return [...new Set(out)];
}

/**
 * Expand a seat-position specification into ordered, de-duplicated 1-based numbers.
 *
 * `1-4, 19, 20` → `[1, 2, 3, 4, 19, 20]`. Positions above `max` are dropped rather than
 * rejected: an operator narrowing a row from 20 seats to 12 should not be blocked by a
 * wheelchair marker they set earlier and cannot see.
 */
export function expandSeatPositions(input: string, max: number): number[] {
  const out: number[] = [];
  for (const rawPart of input.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
      for (let i = from; i <= to; i++) if (i >= 1 && i <= max) out.push(i);
      continue;
    }
    const one = Number(part);
    if (Number.isInteger(one) && one >= 1 && one <= max) out.push(one);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export type SeatKind = 'SEAT' | 'WHEELCHAIR' | 'COMPANION' | 'GAP';

export interface SectionDraft {
  name: string;
  categoryName: string;
  colorHex: string;
  basePrice: string;
  rowLabels: string;
  seatsPerRow: string;
  /** Free-text seat positions, applied to every row in the section. */
  wheelchairSeats: string;
  companionSeats: string;
  gapSeats: string;
}

export interface RowPreview {
  label: string;
  seats: { position: number; kind: SeatKind }[];
}

export interface SectionPreview {
  rows: RowPreview[];
  /** Seats a customer can actually buy — gaps are spacers and sell nothing. */
  sellable: number;
  wheelchair: number;
  companion: number;
  gaps: number;
  total: number;
}

/**
 * What this section will actually produce.
 *
 * Drives the on-screen preview and the running capacity count, which is the other half of
 * making a large room manageable: typing `A-T` and `20` is fast, but nobody can tell at a
 * glance whether that is the 400-seat house they meant.
 *
 * Positions apply to EVERY row in the section. That matches how auditoriums are actually
 * laid out — an accessible bay runs down the same side of the block — and it means one
 * input describes twenty rows instead of twenty inputs describing one each.
 */
export function previewSection(section: SectionDraft): SectionPreview {
  const labels = expandRowLabels(section.rowLabels);
  const perRow = Number(section.seatsPerRow);
  const width = Number.isInteger(perRow) && perRow > 0 ? perRow : 0;

  const wheelchair = new Set(expandSeatPositions(section.wheelchairSeats, width));
  const companion = new Set(expandSeatPositions(section.companionSeats, width));
  const gaps = new Set(expandSeatPositions(section.gapSeats, width));

  const rows: RowPreview[] = labels.map((label) => ({
    label,
    seats: Array.from({ length: width }, (_unused, i) => {
      const position = i + 1;
      // Precedence is deliberate and narrow-to-broad: a gap is structural and wins, then
      // the wheelchair bay, then its companion. Without an order, a position listed twice
      // would resolve differently depending on input order.
      const kind: SeatKind = gaps.has(position)
        ? 'GAP'
        : wheelchair.has(position)
          ? 'WHEELCHAIR'
          : companion.has(position)
            ? 'COMPANION'
            : 'SEAT';
      return { position, kind };
    }),
  }));

  const count = (k: SeatKind) =>
    rows.reduce((n, r) => n + r.seats.filter((s) => s.kind === k).length, 0);
  const total = rows.length * width;
  const gapCount = count('GAP');
  return {
    rows,
    total,
    gaps: gapCount,
    wheelchair: count('WHEELCHAIR'),
    companion: count('COMPANION'),
    sellable: total - gapCount,
  };
}

/** The `seatKinds` entries for one section, in the shape the API expects. */
export function seatKindsFor(
  section: SectionDraft,
): { rowLabel: string; seats: number[]; kind: 'WHEELCHAIR' | 'COMPANION' | 'GAP' }[] {
  const preview = previewSection(section);
  const out: { rowLabel: string; seats: number[]; kind: 'WHEELCHAIR' | 'COMPANION' | 'GAP' }[] = [];
  for (const row of preview.rows) {
    for (const kind of ['WHEELCHAIR', 'COMPANION', 'GAP'] as const) {
      const seats = row.seats.filter((s) => s.kind === kind).map((s) => s.position);
      if (seats.length) out.push({ rowLabel: row.label, seats, kind });
    }
  }
  return out;
}
