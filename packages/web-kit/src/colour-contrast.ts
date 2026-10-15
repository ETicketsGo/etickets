/**
 * Text that stays readable on a colour an organizer chose.
 *
 * Ticket-category colours are picked by organizers, so the venue map cannot assume any of them is
 * light or dark. For each fill this picks black or white - whichever contrasts more - which
 * is always at least 4.5:1 (WCAG AA for small text): black's and white's contrasts with any colour
 * multiply to 21, so the better of the two is never below sqrt(21), about 4.58. A test sweeps
 * colours and holds every one to that floor.
 */

// Pure black, not the near-black body text: with #111827 the worse-off mid-tone fills drop to
// about 4.06:1. Black and white together guarantee the 4.58:1 floor.
const DARK_TEXT = '#000000';
const LIGHT_TEXT = '#FFFFFF';

/** A #RRGGBB colour as 0-255 channels, or null when it is not one. */
export function parseHex(hex: string | null | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of a #RRGGBB colour. */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Near-black or white, whichever reads better on `fill`. */
export function readableTextOn(fill: string): string {
  return contrastRatio(fill, DARK_TEXT) >= contrastRatio(fill, LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT;
}

/** True when the readable text on `fill` is white, i.e. the fill is dark. */
export function isDarkFill(fill: string): boolean {
  return readableTextOn(fill) === LIGHT_TEXT;
}
