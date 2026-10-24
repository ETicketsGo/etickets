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

/*
  The seat map is drawn on the storefront's stage band (brand.css data-brand-tone="stage"),
  so seats are stage colours: an outlined dark seat is free, a gold one is yours (the
  storefront's "seat selection animates the seat fill" in gold), a gold-ringed one is on
  hold for someone else, a dim one is sold. Each state also differs in border weight.
*/
const STAGE: Record<SeatVisualState, SeatStyle> = {
  available: { fill: '#2E2922', border: '#8A8276', label: '#CFC7BA', opacity: 1 },
  selected: { fill: '#E3CFA5', border: '#EDDFC0', label: '#16130F', opacity: 1 },
  // Held by someone else's checkout: "you can't have it" like sold, but distinct because
  // it may free up, and people do wait for exactly that.
  held: { fill: '#3A342C', border: '#B8955A', label: '#E3CFA5', opacity: 1 },
  sold: { fill: '#3A342C', border: '#3A342C', label: '#6A6359', opacity: 0.55 },
  unavailable: { fill: 'transparent', border: '#3A342C', label: '#4D463C', opacity: 0.45 },
};

/** The app is light only; the map is always on a stage, so the scheme no longer matters. */
export function seatStyle(state: SeatVisualState, _scheme?: 'light' | 'dark'): SeatStyle {
  return STAGE[state];
}

/** Plain-language state, used for screen readers and the legend. */
export const SEAT_STATE_LABEL: Record<SeatVisualState, string> = {
  available: 'available',
  selected: 'selected',
  held: 'on hold by another customer',
  sold: 'sold',
  unavailable: 'not available',
};
