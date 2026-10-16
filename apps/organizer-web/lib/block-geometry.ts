/**
 * Plane geometry for blocks on a venue map: move, turn, and tell whether two blocks overlap.
 *
 * -- THE SPACE ----------------------------------------------------------------------------
 * The same abstract 0-1000 square the templates draw in (apps/api/src/shows/venue-templates.ts),
 * y increasing downward. Points are whole numbers, as the templates write them: the map is a
 * diagram for finding your seat, and fractions would only bloat the saved layout.
 *
 * -- WHY OVERLAP IS A WARNING, NOT A RULE ---------------------------------------------------
 * The outline is a picture, not inventory: seats belong to rows, never to a polygon, so two
 * outlines on top of each other sell nothing twice. They do make the map unreadable - a buyer
 * cannot tap the block underneath - so the editor says so in words and lets the organizer fix it,
 * rather than refusing a save while they are halfway through rearranging a room.
 */

export type Pt = [number, number];

export const CANVAS = 1000;

const round = (n: number) => Math.round(n);

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boxOf(points: readonly Pt[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** The average of the corners: where a block's label sits, and what it turns around. */
export function centreOf(points: readonly Pt[]): Pt {
  const sum = points.reduce<[number, number]>((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
  return [round(sum[0] / points.length), round(sum[1] / points.length)];
}

export function translate(points: readonly Pt[], dx: number, dy: number): Pt[] {
  return points.map(([x, y]) => [round(x + dx), round(y + dy)]);
}

/**
 * How far a shape may actually move by (dx, dy) without leaving the canvas.
 *
 * A block dragged past the edge stops AT the edge rather than refusing the whole move: that is
 * what a person dragging it expects, and a block half off the map could never be tapped.
 */
export function clampMove(points: readonly Pt[], dx: number, dy: number): Pt {
  const b = boxOf(points);
  const x = Math.min(CANVAS - b.maxX, Math.max(-b.minX, dx));
  const y = Math.min(CANVAS - b.maxY, Math.max(-b.minY, dy));
  return [round(x), round(y)];
}

/** Turn points clockwise (on screen) by `deg` around a centre. */
export function rotate(points: readonly Pt[], deg: number, about: Pt): Pt[] {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return points.map(([x, y]) => {
    const rx = x - about[0];
    const ry = y - about[1];
    return [round(about[0] + rx * cos - ry * sin), round(about[1] + rx * sin + ry * cos)];
  });
}

/** Move a shape the least distance that brings it fully inside the canvas. */
export function keepInside(points: readonly Pt[]): Pt[] {
  const b = boxOf(points);
  const dx = b.minX < 0 ? -b.minX : b.maxX > CANVAS ? CANVAS - b.maxX : 0;
  const dy = b.minY < 0 ? -b.minY : b.maxY > CANVAS ? CANVAS - b.maxY : 0;
  return dx === 0 && dy === 0 ? [...points] : translate(points, dx, dy);
}

export function rectangle(cx: number, cy: number, width: number, height: number): Pt[] {
  const x = cx - width / 2;
  const y = cy - height / 2;
  return [
    [round(x), round(y)],
    [round(x + width), round(y)],
    [round(x + width), round(y + height)],
    [round(x), round(y + height)],
  ];
}

/** Degrees in 0..359, as the layout stores a block's turn. */
export const normaliseDeg = (deg: number) => ((Math.round(deg) % 360) + 360) % 360;

// -- Overlap ------------------------------------------------------------------------------

const boxesOverlap = (a: Box, b: Box) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

/** Ray casting. A point exactly on an edge counts as outside, so touching is not overlapping. */
function inside(point: Pt, poly: readonly Pt[]): boolean {
  const [x, y] = point;
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const cross = (o: Pt, a: Pt, b: Pt) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Two segments cross at a point inside both. Segments that only touch or run along each other do not. */
function segmentsCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Whether two outlines cover some of the same ground (more than a shared edge).
 *
 * Edges crossing catches every partial overlap; a corner inside the other catches one block
 * wholly inside another, where no edges cross. The centre test catches two identical outlines
 * (a block copied onto its source), where neither edges cross nor a corner is strictly inside.
 */
export function overlaps(a: readonly Pt[], b: readonly Pt[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  if (!boxesOverlap(boxOf(a), boxOf(b))) return false;
  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j += 1) {
      if (segmentsCross(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  if (a.some((p) => inside(p, b)) || b.some((p) => inside(p, a))) return true;
  return inside(centreOf(a), b) || inside(centreOf(b), a);
}

/** A polygon's area (shoelace), in square map units. */
export function areaOf(points: readonly Pt[]): number {
  let twice = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    twice += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
  }
  return Math.abs(twice) / 2;
}

/**
 * Roughly how much ground two outlines share, by sampling a grid over where their boxes meet.
 * Exact enough to tell "covers half of it" from the sliver two neighbouring wedges share once
 * their corners are rounded to whole numbers.
 */
export function sharedArea(a: readonly Pt[], b: readonly Pt[]): number {
  if (!overlaps(a, b)) return 0;
  const ba = boxOf(a);
  const bb = boxOf(b);
  const minX = Math.max(ba.minX, bb.minX);
  const minY = Math.max(ba.minY, bb.minY);
  const maxX = Math.min(ba.maxX, bb.maxX);
  const maxY = Math.min(ba.maxY, bb.maxY);
  // At most about 60 x 60 samples, never finer than a unit.
  const step = Math.max(1, Math.max(maxX - minX, maxY - minY) / 60);
  let hits = 0;
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      if (inside([x, y], a) && inside([x, y], b)) hits += 1;
    }
  }
  return hits * step * step;
}

/**
 * Whether one block covers enough of another that a buyer could not tell them apart or tap the
 * one underneath: more than 3% of the smaller block (and more than a 15 x 15 patch). Template
 * blocks that only share an edge, rounded to whole numbers, never reach that.
 */
export function coversNotably(a: readonly Pt[], b: readonly Pt[]): boolean {
  const shared = sharedArea(a, b);
  if (shared === 0) return false;
  return shared > Math.max(225, 0.03 * Math.min(areaOf(a), areaOf(b)));
}

// -- Drawing ------------------------------------------------------------------------------

/** A point moved onto the canvas and rounded, as a drawn corner is stored. */
export function clampPoint([x, y]: readonly [number, number]): Pt {
  return [round(Math.min(CANVAS, Math.max(0, x))), round(Math.min(CANVAS, Math.max(0, y)))];
}

/** The rectangle between two opposite corners, as a person drags it out, in either direction. */
export function rectangleFromCorners(a: readonly [number, number], b: readonly [number, number]) {
  const [x0, y0] = clampPoint(a);
  const [x1, y1] = clampPoint(b);
  const [minX, maxX] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [minY, maxY] = y0 <= y1 ? [y0, y1] : [y1, y0];
  const out: Pt[] = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  return out;
}

/** Whether a new corner is (almost) where the last one is: a double tap, not a new corner. */
export const sameCorner = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.abs(a[0] - b[0]) <= 3 && Math.abs(a[1] - b[1]) <= 3;

/**
 * Whether an outline's edges cross each other, like a figure eight. Corners tapped out of order
 * make one; it has no inside a buyer could tap, and its label lands in the wrong place.
 */
export function selfCrosses(points: readonly Pt[]): boolean {
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 2; j < n; j += 1) {
      // The first and last edges meet at the first corner: neighbours, not a crossing.
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n]))
        return true;
    }
  }
  return false;
}

/**
 * Where a block's name goes: the middle of its area, so it sits inside the block.
 *
 * The average of the corners (what template blocks use) drifts towards wherever the corners are
 * crowded, and for an L-shaped outline even the area's middle can fall outside it. So: the area's
 * middle when that is inside; otherwise the middle of the widest stretch of the outline on the
 * same level.
 */
export function labelPointOf(points: readonly Pt[]): Pt {
  const twice = points.reduce(
    (a, p, i) => {
      const q = points[(i + 1) % points.length];
      const c = p[0] * q[1] - q[0] * p[1];
      return [a[0] + c, a[1] + (p[0] + q[0]) * c, a[2] + (p[1] + q[1]) * c];
    },
    [0, 0, 0],
  );
  if (Math.abs(twice[0]) < 1e-9) return centreOf(points);
  const centre: Pt = [round(twice[1] / (3 * twice[0])), round(twice[2] / (3 * twice[0]))];
  if (inside(centre, points)) return centre;
  const y = centre[1];
  const xs: number[] = [];
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
  }
  xs.sort((a, b) => a - b);
  let best: Pt | null = null;
  let widest = -1;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    if (xs[k + 1] - xs[k] > widest) {
      widest = xs[k + 1] - xs[k];
      best = [round((xs[k] + xs[k + 1]) / 2), y];
    }
  }
  return best ?? centreOf(points);
}

/**
 * Where to put a new block so it lands on empty ground, as near to `prefer` as possible.
 *
 * Tries centres on a grid, nearest first, and returns the shape moved there; if the map is full
 * it returns the shape at `prefer` (inside the canvas) and the editor says it overlaps.
 */
export function freeSpot(
  shape: readonly Pt[],
  taken: readonly (readonly Pt[])[],
  prefer: Pt,
): Pt[] {
  const here = centreOf(shape);
  const candidates: Pt[] = [];
  const step = 20;
  for (let x = step; x < CANVAS; x += step) {
    for (let y = step; y < CANVAS; y += step) candidates.push([x, y]);
  }
  candidates.sort(
    (p, q) =>
      (p[0] - prefer[0]) ** 2 +
      (p[1] - prefer[1]) ** 2 -
      (q[0] - prefer[0]) ** 2 -
      (q[1] - prefer[1]) ** 2,
  );
  const size = boxOf(shape);
  for (const [cx, cy] of candidates) {
    const moved = translate(shape, cx - here[0], cy - here[1]);
    const b = boxOf(moved);
    if (b.minX < 0 || b.minY < 0 || b.maxX > CANVAS || b.maxY > CANVAS) continue;
    if (size.maxX - size.minX > CANVAS || size.maxY - size.minY > CANVAS) break;
    if (!taken.some((t) => overlaps(moved, t))) return moved;
  }
  return keepInside(translate(shape, prefer[0] - here[0], prefer[1] - here[1]));
}
