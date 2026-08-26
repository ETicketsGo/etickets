import {
  VENUE_TEMPLATES,
  centroid,
  generateVenue,
  rowLabel,
  seatCount,
  type GeneratedVenue,
  type Point,
  type VenueTemplateKey,
} from './venue-templates';

/**
 * Venue geometry.
 *
 * The trap with generated maps is that every bug looks like success from the inside. A
 * template that returns forty sections, four thousand seats and well-formed polygons can
 * still draw a bow tie, put two blocks on top of each other, or hide a section off the
 * edge of the canvas — and every assertion of the form "expect(sections).toHaveLength(40)"
 * passes throughout. So these tests check the properties a map has to have to be usable,
 * and check them for every template rather than for a favourite one.
 */

const ALL: VenueTemplateKey[] = VENUE_TEMPLATES.map((t) => t.key);

// ── Geometry predicates ─────────────────────────────────────────────────────────────

/** Twice the signed area. Negative or positive is fine; zero means the polygon is degenerate. */
function signedArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function onSegment(p: Point, q: Point, r: Point): boolean {
  return (
    Math.min(p[0], r[0]) <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] &&
    q[1] <= Math.max(p[1], r[1])
  );
}

const orientation = (p: Point, q: Point, r: Point): number => {
  const v = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
  return v === 0 ? 0 : v > 0 ? 1 : 2;
};

function segmentsCross(p1: Point, q1: Point, p2: Point, q2: Point): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

/**
 * Whether a polygon crosses itself — the bow-tie test.
 *
 * Adjacent edges share a vertex and so always "touch"; only non-adjacent pairs count.
 */
function selfIntersects(points: Point[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      if (segmentsCross(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) {
        return true;
      }
    }
  }
  return false;
}

/** Ray casting. Used to check labels land inside the block they name. */
function contains(points: Point[], [px, py]: Point): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const straddles = yi > py !== yj > py;
    if (straddles && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Do two polygons share any area?
 *
 * Bounding boxes are not enough here: a ring segment's box covers the middle of the arena,
 * where the stage is, without the segment itself going anywhere near it. So this checks
 * what actually matters — whether any edges cross, and whether either shape is wholly
 * inside the other.
 */
function polygonsOverlap(a: Point[], b: Point[]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) {
        return true;
      }
    }
  }
  // Containment with no crossing: one shape entirely swallowed by the other.
  return contains(a, b[0]) || contains(b, a[0]);
}

function boundingBox(points: Point[]) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function boxesOverlap(a: Point[], b: Point[]): boolean {
  const A = boundingBox(a);
  const B = boundingBox(b);
  return A.minX < B.maxX && B.minX < A.maxX && A.minY < B.maxY && B.minY < A.maxY;
}

// ── Tests ───────────────────────────────────────────────────────────────────────────

describe('venue templates', () => {
  describe.each(ALL)('%s', (key) => {
    let venue: GeneratedVenue;
    beforeAll(() => {
      venue = generateVenue(key);
    });

    it('produces sections, seats and price bands', () => {
      expect(venue.sections.length).toBeGreaterThan(0);
      expect(venue.categories.length).toBeGreaterThan(0);
      expect(seatCount(venue)).toBeGreaterThan(0);
    });

    it('keeps every polygon inside the canvas', () => {
      // A section drawn off the edge is one nobody can click, and its seats are unsellable
      // through the map even though the API will happily quote for them.
      const escaped = venue.sections
        .filter((s) => {
          const b = boundingBox(s.shape);
          return b.minX < 0 || b.minY < 0 || b.maxX > 1000 || b.maxY > 1000;
        })
        .map((s) => s.name);
      expect(escaped).toEqual([]);
    });

    it('draws no bow ties', () => {
      // A ring segment assembled in the wrong order looks like a valid polygon by every
      // count-based assertion, and renders as an hourglass.
      const crossed = venue.sections.filter((s) => selfIntersects(s.shape)).map((s) => s.name);
      expect(crossed).toEqual([]);
    });

    it('gives every polygon real area', () => {
      const flat = venue.sections
        .filter((s) => Math.abs(signedArea(s.shape)) < 100)
        .map((s) => s.name);
      expect(flat).toEqual([]);
    });

    it('puts every section label inside its own section', () => {
      // Labels are placed at the centroid, which is correct for every shape here and would
      // NOT be for a concave one — an L-shaped or horseshoe block puts its own label outside
      // itself. This is the guard for the day a template grows one.
      const stray = venue.sections
        .filter((s) => !contains(s.shape, [s.labelX, s.labelY]))
        .map((s) => s.name);
      expect(stray).toEqual([]);
    });

    it('names every section exactly once', () => {
      // Two blocks called "Lower 104" is a customer standing in the wrong queue.
      const names = venue.sections.map((s) => s.name);
      expect(names.length).toBe(new Set(names).size);
    });

    it('points every section at a price band that exists', () => {
      const known = new Set(venue.categories.map((c) => c.name));
      const dangling = venue.sections.filter((s) => !known.has(s.categoryName)).map((s) => s.name);
      expect(dangling).toEqual([]);
    });

    it('numbers seats from 1 and rows from A, the way signage does', () => {
      for (const section of venue.sections) {
        expect(section.rows[0].label).toBe('A');
        expect(section.rows[0].seats[0].label).toBe('1');
      }
    });

    it('includes somewhere for a wheelchair user to sit', () => {
      /*
        Checked for every template, deliberately.

        A generated layout with no accessible seating is one somebody has to remember to
        fix by hand, and the consistent evidence is that nobody does until a customer
        cannot book. Every template puts a bay and its companion seat in a ground-level
        block.
      */
      const kinds = venue.sections.flatMap((s) =>
        s.rows.flatMap((r) => r.seats.map((x) => x.kind)),
      );
      expect(kinds).toContain('WHEELCHAIR');
      expect(kinds).toContain('COMPANION');
    });

    it('gives every block a name short enough to fit inside it', () => {
      /*
        The label is drawn INSIDE the polygon at a fixed size, and SVG text does not wrap.

        "North west corner" ran clear across the stand beside it and collided with that
        stand's own label; "Front Right centre" bled into two neighbouring wedges. Both
        looked fine in every assertion about geometry, because the geometry WAS fine — it
        was the words that did not fit.
      */
      // Twelve fits the narrowest block any template produces — a stadium stand split into
      // four is about ninety units wide, and a character is roughly nine at this font size.
      const tooLong = venue.sections.filter((s) => s.name.length > 12).map((s) => s.name);
      expect(tooLong).toEqual([]);
    });

    it('never draws seating on top of the stage', () => {
      /*
        The bug this exists for, found by looking at a rendered map rather than at a number.

        The arena put its stage in the middle of the floor and then laid two of the four
        floor blocks across it — seating drawn over the performance, with the word STAGE
        half-hidden behind them. Every geometry assertion passed: they all compared sections
        with other sections, and nothing ever compared a section with the focal shape.
      */
      const onTopOfTheStage = venue.sections
        .filter((s) => polygonsOverlap(s.shape, venue.focalShape))
        .map((s) => s.name);
      expect(onTopOfTheStage).toEqual([]);
    });

    it('is deterministic — the same template twice is the same venue', () => {
      // Anything random here would mean an organizer previewing a map and then generating a
      // different one, and a regenerated layout silently disagreeing with sold tickets.
      expect(generateVenue(key)).toEqual(generateVenue(key));
    });
  });

  describe('sections do not sit on top of each other', () => {
    // Checked by bounding box, which is coarse — two ring segments in the same band have
    // overlapping boxes without overlapping at all. So this runs only on the templates built
    // from rectangles, where the box IS the shape and an overlap is a real one.
    it.each<VenueTemplateKey>(['CINEMA', 'PROSCENIUM', 'STADIUM'])('%s', (key) => {
      const venue = generateVenue(key);
      const collisions: string[] = [];
      for (let i = 0; i < venue.sections.length; i++) {
        for (let j = i + 1; j < venue.sections.length; j++) {
          if (boxesOverlap(venue.sections[i].shape, venue.sections[j].shape)) {
            collisions.push(`${venue.sections[i].name} / ${venue.sections[j].name}`);
          }
        }
      }
      expect(collisions).toEqual([]);
    });
  });

  describe('scale', () => {
    it('produces roughly the seat count the picker advertises', () => {
      // The number in the picker is what an organizer chooses on, so it is measured rather
      // than estimated and held to within 5%. The first version advertised round-sounding
      // guesses and was out by more than 2x on two templates.
      const wrong = VENUE_TEMPLATES.filter((t) => {
        const actual = seatCount(generateVenue(t.key));
        return Math.abs(actual - t.approximateSeats) / t.approximateSeats > 0.05;
      }).map(
        (t) => `${t.key}: claims ${t.approximateSeats}, builds ${seatCount(generateVenue(t.key))}`,
      );
      expect(wrong).toEqual([]);
    });

    it('scales with the parameters it is given', () => {
      const small = seatCount(generateVenue('PROSCENIUM', { rows: 6, seatsPerRow: 10 }));
      const large = seatCount(generateVenue('PROSCENIUM', { rows: 20, seatsPerRow: 30 }));
      expect(large).toBeGreaterThan(small * 2);
    });
  });

  describe('the cinema template stays a grid', () => {
    it('does not turn every existing screen into a venue map', () => {
      // The whole reason GRID is the default. A cinema rendered as a one-polygon "venue map"
      // would be a worse version of the seat picker it already has.
      expect(generateVenue('CINEMA').layoutKind).toBe('GRID');
      expect(generateVenue('CINEMA').focalLabel).toBe('SCREEN');
    });
  });

  describe('rowLabel', () => {
    it('keeps counting past Z, which a 30-row stand needs', () => {
      expect(rowLabel(0)).toBe('A');
      expect(rowLabel(25)).toBe('Z');
      // Not "[", which is what String.fromCharCode(65 + 26) gives.
      expect(rowLabel(26)).toBe('AA');
      expect(rowLabel(27)).toBe('AB');
      expect(rowLabel(51)).toBe('AZ');
      expect(rowLabel(52)).toBe('BA');
    });
  });

  describe('centroid', () => {
    it('finds the middle of a square', () => {
      expect(
        centroid([
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ]),
      ).toEqual([5, 5]);
    });
  });

  it('refuses an unknown template rather than returning an empty venue', () => {
    // An empty venue would be saved as a layout with no seats, and only discovered when a
    // show scheduled against it had nothing to sell.
    expect(() => generateVenue('WAREHOUSE' as VenueTemplateKey)).toThrow(/unknown venue template/i);
  });
});
