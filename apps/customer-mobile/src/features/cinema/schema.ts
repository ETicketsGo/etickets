import { z } from 'zod';

/**
 * Runtime contract for GET /public/shows/:sessionId/seats.
 *
 * Verified against the QA API on 2026-08-04 (session cmsdp3od100758jznrl6atlru), and
 * cross-checked against the projection in apps/api/src/shows/shows.service.ts so the
 * optional/nullable marks below match what the server can actually emit rather than
 * what one sample happened to contain.
 */

/**
 * Seat state, and the app treats the server as the only source of it.
 *
 * The API stores this as a free string (ShowSeat.status) with three values in practice.
 * It is parsed as an open string rather than a z.enum on purpose: an unrecognised state
 * from a newer API must render as unselectable, not throw away the whole seat map and
 * leave the user unable to book anything.
 */
export const SEAT_STATUSES = ['AVAILABLE', 'HELD', 'SOLD'] as const;
export type KnownSeatStatus = (typeof SEAT_STATUSES)[number];

export const seatSchema = z.object({
  id: z.string(),
  /** Seat number within the row ("12"). Combined with the row label for "A12". */
  label: z.string(),
  /** Position within the row. Used for layout so holes in the sequence stay holes. */
  colIndex: z.number().int(),
  categoryId: z.string(),
  status: z.string(),
});

export const seatRowSchema = z.object({
  label: z.string(),
  seats: z.array(seatSchema),
});

export const seatSectionSchema = z.object({
  name: z.string(),
  rows: z.array(seatRowSchema),
});

export const seatCategorySchema = z.object({
  id: z.string(),
  /**
   * NULLABLE, and it matters: the server returns null when no ticket type is mapped to
   * this seat category for this session. Seats in such a category have no price and
   * cannot be added to a booking, because a booking line is keyed by ticketTypeId.
   */
  ticketTypeId: z.string().nullable(),
  name: z.string(),
  colorHex: z.string().nullable(),
  priceMinor: z.number().int(),
});

export const seatMapSchema = z.object({
  sessionId: z.string(),
  categories: z.array(seatCategorySchema),
  sections: z.array(seatSectionSchema),
});

export type Seat = z.infer<typeof seatSchema>;
export type SeatRow = z.infer<typeof seatRowSchema>;
export type SeatSection = z.infer<typeof seatSectionSchema>;
export type SeatCategory = z.infer<typeof seatCategorySchema>;
export type SeatMap = z.infer<typeof seatMapSchema>;

/**
 * Whether a seat can be picked, from the SERVER's status alone.
 *
 * Deliberately not "status !== 'SOLD'": anything the app does not recognise is treated
 * as unavailable. Erring toward unselectable costs a user one seat; erring the other
 * way sends a booking for a seat someone else is sitting in.
 */
export function isSelectable(seat: Seat, category: SeatCategory | undefined): boolean {
  return seat.status === 'AVAILABLE' && Boolean(category?.ticketTypeId);
}

/** Human-facing state for a seat, including the app's own selection overlay. */
export type SeatVisualState = 'available' | 'selected' | 'held' | 'sold' | 'unavailable';

export function seatVisualState(
  seat: Seat,
  category: SeatCategory | undefined,
  selected: boolean,
): SeatVisualState {
  // Selection is a local overlay on an AVAILABLE seat and never masks a server state:
  // if the server says SOLD, that wins even if this device thinks it is selected.
  if (seat.status === 'SOLD') return 'sold';
  if (seat.status === 'HELD') return 'held';
  if (!category?.ticketTypeId) return 'unavailable';
  if (seat.status !== 'AVAILABLE') return 'unavailable';
  return selected ? 'selected' : 'available';
}

/** "A12" — the label a user reads out at the door. */
export function seatName(rowLabel: string, seat: Seat): string {
  return `${rowLabel}${seat.label}`;
}
