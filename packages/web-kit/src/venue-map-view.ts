/**
 * What part of the venue map is on screen: the frame around the venue, and the zoom inside it.
 *
 * -- WHY THE MAP NOW ZOOMS ----------------------------------------------------------------
 * The map scales to its box, and its labels with it. On a 390px phone the box is about 320px
 * wide, so a block's name rendered at 7-9px and its price at about 6px: a buyer could tap a
 * block without being able to read which one it was or what it cost. Two things fix that, both
 * here as pure arithmetic so they are tested without a browser:
 *
 * 1. FRAME THE VENUE, NOT THE CANVAS. Templates draw in a 0-1000 square, but an amphitheatre
 *    uses only its top half. Framing the blocks and the stage (plus a margin) instead of the
 *    whole square makes everything larger at once, with no gesture at all.
 * 2. ZOOM. Buttons, a pinch, or ctrl + wheel narrow the visible part of the frame; the labels
 *    are drawn in map units, so they grow with it. One finger then moves around the venue.
 *
 * The svg keeps the FRAME's proportions whatever the zoom, so zooming never changes the size of
 * the box on the page - only what is inside it.
 */

export type MapPoint = [number, number];

/** A rectangle in map units. */
export interface MapBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How far in, and where the middle of the view is (map units). */
export interface MapView {
  scale: number;
  cx: number;
  cy: number;
}

export const MAP_CANVAS = 1000;
/** Far enough in to read a block of a 60-block stadium on a phone; further only loses context. */
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 1.5;
/** Room around the venue, so outlines and the halo around their names are never clipped. */
const MARGIN = 24;

/** The whole 0-1000 canvas: the layout editor's frame, where a block may be moved anywhere. */
export const FULL_CANVAS: MapBox = { x: 0, y: 0, w: MAP_CANVAS, h: MAP_CANVAS };

/**
 * The frame around everything drawn: every outline and the stage, with a margin, inside the
 * canvas. Never narrower than a third of the canvas either way, so one small block is not blown
 * up to fill the screen.
 */
export function frameAround(shapes: readonly (readonly MapPoint[])[]): MapBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    for (const [x, y] of shape) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return FULL_CANVAS;
  const least = MAP_CANVAS / 3;
  let x0 = Math.max(0, minX - MARGIN);
  let y0 = Math.max(0, minY - MARGIN);
  let x1 = Math.min(MAP_CANVAS, maxX + MARGIN);
  let y1 = Math.min(MAP_CANVAS, maxY + MARGIN);
  if (x1 - x0 < least) {
    const mid = (x0 + x1) / 2;
    x0 = Math.max(0, Math.min(MAP_CANVAS - least, mid - least / 2));
    x1 = x0 + least;
  }
  if (y1 - y0 < least) {
    const mid = (y0 + y1) / 2;
    y0 = Math.max(0, Math.min(MAP_CANVAS - least, mid - least / 2));
    y1 = y0 + least;
  }
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

/** The whole frame, unzoomed. */
export const homeView = (frame: MapBox): MapView => ({
  scale: 1,
  cx: frame.x + frame.w / 2,
  cy: frame.y + frame.h / 2,
});

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

/** A view whose visible part stays inside the frame: zoom 1..MAX, and no panning off the edge. */
export function clampView(frame: MapBox, view: MapView): MapView {
  const scale = clamp(view.scale, 1, MAX_ZOOM);
  const w = frame.w / scale;
  const h = frame.h / scale;
  return {
    scale,
    cx: clamp(view.cx, frame.x + w / 2, frame.x + frame.w - w / 2),
    cy: clamp(view.cy, frame.y + h / 2, frame.y + frame.h - h / 2),
  };
}

/** The svg viewBox for a view. */
export function viewBoxOf(frame: MapBox, view: MapView): MapBox {
  const v = clampView(frame, view);
  const w = frame.w / v.scale;
  const h = frame.h / v.scale;
  return { x: v.cx - w / 2, y: v.cy - h / 2, w, h };
}

/**
 * Zoom to `scale`, keeping one map point where it is on screen: the point under the fingers of
 * a pinch, under the pointer for ctrl + wheel, or the middle of the view for the buttons.
 * `at` is that point's position across the box, 0..1 each way.
 */
export function zoomTo(
  frame: MapBox,
  scale: number,
  anchor: MapPoint,
  at: MapPoint = [0.5, 0.5],
): MapView {
  const s = clamp(scale, 1, MAX_ZOOM);
  const w = frame.w / s;
  const h = frame.h / s;
  return clampView(frame, {
    scale: s,
    cx: anchor[0] - at[0] * w + w / 2,
    cy: anchor[1] - at[1] * h + h / 2,
  });
}

/** Move the view by a distance on screen (px), for a box `boxPx` wide showing this view. */
export function panBy(
  frame: MapBox,
  view: MapView,
  dxPx: number,
  dyPx: number,
  boxPx: number,
): MapView {
  const unitsPerPx = frame.w / view.scale / Math.max(1, boxPx);
  return clampView(frame, {
    ...view,
    cx: view.cx - dxPx * unitsPerPx,
    cy: view.cy - dyPx * unitsPerPx,
  });
}

/** The map point under a position in the box (px from its top-left, for a box `boxPx` wide). */
export function pointAt(
  frame: MapBox,
  view: MapView,
  px: number,
  py: number,
  boxPx: number,
): MapPoint {
  const vb = viewBoxOf(frame, view);
  const unitsPerPx = vb.w / Math.max(1, boxPx);
  return [vb.x + px * unitsPerPx, vb.y + py * unitsPerPx];
}
