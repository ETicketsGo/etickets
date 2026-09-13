/**
 * The keyboard focus ring every control on the film page shares.
 *
 * Offset against the canvas so it stays visible on a solid accent tile. Anything that scrolls
 * horizontally gives its children padding for it, or the ring is clipped to nothing.
 */
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-canvas';
