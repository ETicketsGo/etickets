import { BRAND_FOCUS } from '@eticketsgo/web-kit';

/**
 * The keyboard focus ring every control on the film page shares: the brand's, now that the
 * film page is on the brand layer (docs/design/DESIGN-SYSTEM.md).
 *
 * Offset against the canvas so it stays visible on a solid ink tile. Anything that scrolls
 * horizontally gives its children padding for it, or the ring is clipped to nothing.
 */
export const focusRing = BRAND_FOCUS;
