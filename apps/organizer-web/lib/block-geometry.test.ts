import { describe, expect, it } from 'vitest';
import {
  boxOf,
  centreOf,
  clampMove,
  coversNotably,
  freeSpot,
  normaliseDeg,
  overlaps,
  rectangle,
  rotate,
  type Pt,
} from './block-geometry';

const square = (x: number, y: number, size = 100): Pt[] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];

describe('block geometry', () => {
  it('stops a block at the edge of the map instead of letting it leave', () => {
    const s = square(850, 20);
    expect(clampMove(s, 200, -100)).toEqual([50, -20]);
    expect(clampMove(s, -30, 40)).toEqual([-30, 40]);
  });

  it('turns a block clockwise around its own middle', () => {
    const turned = rotate(square(100, 100), 90, centreOf(square(100, 100)));
    // A square turned a quarter keeps its footprint: same box, same middle.
    expect(boxOf(turned)).toEqual({ minX: 100, minY: 100, maxX: 200, maxY: 200 });
    // The top-left corner goes to the top-right, as a clockwise turn on screen does.
    expect(turned[0]).toEqual([200, 100]);
    expect(normaliseDeg(-15)).toBe(345);
    expect(normaliseDeg(375)).toBe(15);
  });

  it('tells overlapping blocks from neighbours that only touch', () => {
    expect(overlaps(square(0, 0), square(50, 50))).toBe(true);
    // One wholly inside the other: no edges cross, still an overlap.
    expect(overlaps(square(0, 0, 300), square(100, 100))).toBe(true);
    // An exact copy on top of its source.
    expect(overlaps(square(10, 10), square(10, 10))).toBe(true);
    // Sharing an edge is not overlapping; apart is not either.
    expect(overlaps(square(0, 0), square(100, 0))).toBe(false);
    expect(overlaps(square(0, 0), square(300, 300))).toBe(false);
  });

  it('warns only when a block really covers another, never for neighbours sharing an edge', () => {
    // Rear 1 and Rear 2 of the amphitheatre template on QA, exactly as stored. They share an
    // edge, and with corners rounded to whole numbers the plain test calls that an overlap.
    const rear1: Pt[] = [
      [146, 464],
      [117, 431],
      [90, 397],
      [67, 360],
      [47, 321],
      [30, 281],
      [17, 239],
      [172, 198],
      [181, 226],
      [192, 254],
      [206, 280],
      [221, 305],
      [240, 329],
      [260, 350],
    ];
    const rear2: Pt[] = [
      [371, 593],
      [329, 580],
      [289, 563],
      [250, 543],
      [213, 520],
      [179, 493],
      [146, 464],
      [260, 350],
      [281, 370],
      [305, 389],
      [330, 404],
      [356, 418],
      [384, 429],
      [412, 438],
    ];
    expect(coversNotably(rear1, rear2)).toBe(false);
    // Moved 40 units onto its neighbour, it does cover it.
    expect(
      coversNotably(
        rear1.map(([x, y]) => [x + 40, y + 40] as Pt),
        rear2,
      ),
    ).toBe(true);
    expect(coversNotably(square(0, 0), square(50, 50))).toBe(true);
    expect(coversNotably(square(0, 0), square(98, 0))).toBe(false);
  });

  it('puts a new block on empty ground near where it was asked for', () => {
    const taken = [square(400, 400, 200)];
    const placed = freeSpot(rectangle(0, 0, 100, 60), taken, [500, 500]);
    expect(taken.some((t) => overlaps(placed, t))).toBe(false);
    const b = boxOf(placed);
    expect(b.minX).toBeGreaterThanOrEqual(0);
    expect(b.maxY).toBeLessThanOrEqual(1000);
    // Near the middle, not in a far corner.
    const [cx, cy] = centreOf(placed);
    expect(Math.hypot(cx - 500, cy - 500)).toBeLessThan(220);
  });
});
