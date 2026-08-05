import type { SeatVisualState } from './schema';

/**
 * Seat colours.
 *
 * Literal hex rather than NativeWind classes: seats are drawn by the hundred, and
 * resolving a class string per seat per render is measurably worse than handing the
 * renderer a colour. The values mirror the palette in global.css.
 *
 * Colour is never the ONLY signal — every state also differs in border and fill weight,
 * and the accessible list view (seat-list.tsx) states each one in words. Roughly one man
 * in twelve cannot reliably separate the red "sold" from the green "available".
 */
export interface SeatStyle {
  fill: string;
  border: string;
  /** Text colour for the seat number, when the seat is large enough to show one. */
  label: string;
  opacity: number;
}

const LIGHT: Record<SeatVisualState, SeatStyle> = {
  available: { fill: '#FFFFFF', border: '#94A3B8', label: '#475569', opacity: 1 },
  selected: { fill: '#2563EB', border: '#1D4ED8', label: '#FFFFFF', opacity: 1 },
  // Held by someone else's in-flight checkout — same "you can't have it" as sold, but
  // distinct because it may free up, and users do wait for exactly that.
  held: { fill: '#FDE68A', border: '#D97706', label: '#92400E', opacity: 1 },
  sold: { fill: '#CBD5E1', border: '#94A3B8', label: '#64748B', opacity: 1 },
  unavailable: { fill: '#E2E8F0', border: '#CBD5E1', label: '#94A3B8', opacity: 0.55 },
};

const DARK: Record<SeatVisualState, SeatStyle> = {
  available: { fill: '#1E293B', border: '#64748B', label: '#CBD5E1', opacity: 1 },
  selected: { fill: '#2563EB', border: '#60A5FA', label: '#FFFFFF', opacity: 1 },
  held: { fill: '#78350F', border: '#D97706', label: '#FDE68A', opacity: 1 },
  sold: { fill: '#334155', border: '#475569', label: '#64748B', opacity: 1 },
  unavailable: { fill: '#1E293B', border: '#334155', label: '#475569', opacity: 0.5 },
};

export function seatStyle(state: SeatVisualState, scheme: 'light' | 'dark'): SeatStyle {
  return (scheme === 'dark' ? DARK : LIGHT)[state];
}

/** Plain-language state, used for screen readers and the legend. */
export const SEAT_STATE_LABEL: Record<SeatVisualState, string> = {
  available: 'available',
  selected: 'selected',
  held: 'on hold by another customer',
  sold: 'sold',
  unavailable: 'not available',
};
