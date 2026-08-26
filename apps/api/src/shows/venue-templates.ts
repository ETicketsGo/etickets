/**
 * Venue shapes an organizer can start from.
 *
 * ── WHY TEMPLATES AND NOT A DRAWING TOOL ───────────────────────────────────────────
 * A sectioned venue is a few dozen polygons and a few thousand seats. Asking an organizer
 * to draw that is asking them to do a day of work before they can sell a ticket, and the
 * result would be a map that is subtly wrong in a way only their customers discover.
 *
 * Almost every real venue is a variation on four shapes, though — a room facing a screen,
 * a stage at one end, a bowl around a floor, a pitch with four stands. So this generates a
 * complete, correct, sellable map from a handful of numbers, and the organizer edits from
 * there. Getting to "wrong in one place" beats getting to "empty".
 *
 * ── THE COORDINATE SPACE ───────────────────────────────────────────────────────────
 * Everything is in an abstract 0–1000 square with y increasing downward, matching how SVG
 * and every screen coordinate system already work. Abstract rather than metres because the
 * map is a diagram for finding your seat, not a survey — and a unitless square renders the
 * same on a phone and on a box-office wall display.
 *
 * ── PURE ON PURPOSE ────────────────────────────────────────────────────────────────
 * No database, no ids, no Prisma. These functions take numbers and return a description of
 * a venue, which means the geometry can be tested for the things that actually matter —
 * that sections do not overlap, that seat counts are what was asked for, that no polygon
 * escapes the canvas — without a schema in the way.
 */

import { VENUE_TEMPLATES, type VenueTemplateKey } from '@eticketsgo/shared-types';

// Re-exported so the geometry and the catalogue read as one module to callers here.
export { VENUE_TEMPLATES, type VenueTemplateKey };

/** A point in the 0–1000 space. */
export type Point = [number, number];

export interface TemplateSeat {
  label: string;
  colIndex: number;
  /** SEAT | GAP | WHEELCHAIR | COMPANION — same vocabulary as the Seat model. */
  kind: string;
}

export interface TemplateRow {
  label: string;
  sortOrder: number;
  seats: TemplateSeat[];
}

export interface TemplateSection {
  name: string;
  sortOrder: number;
  shape: Point[];
  labelX: number;
  labelY: number;
  tier: string;
  /** Degrees clockwise, so a side block's rows face the stage rather than the top edge. */
  rotationDeg: number;
  /** Which price band this block belongs to, by name. Resolved to a category by the caller. */
  categoryName: string;
  rows: TemplateRow[];
}

export interface TemplateCategory {
  name: string;
  colorHex: string;
  sortOrder: number;
  /** Relative price weight, not a price. The organizer sets real money afterwards. */
  priceWeight: number;
}

export interface GeneratedVenue {
  layoutKind: 'GRID' | 'SECTIONED';
  focalPoint: 'SCREEN' | 'STAGE_END' | 'STAGE_THRUST' | 'STAGE_CENTRE' | 'FIELD';
  focalShape: Point[];
  focalLabel: string;
  categories: TemplateCategory[];
  sections: TemplateSection[];
}

// ── Geometry helpers ────────────────────────────────────────────────────────────────

const CANVAS = 1000;
const CENTRE: Point = [500, 500];

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** A point on a circle. 0° is straight up; degrees increase clockwise, as on a compass. */
function polar(centre: Point, radius: number, deg: number): Point {
  const a = toRad(deg - 90);
  return [round(centre[0] + radius * Math.cos(a)), round(centre[1] + radius * Math.sin(a))];
}

/** Whole numbers: the map is a diagram, and sub-pixel precision only bloats the payload. */
const round = (n: number) => Math.round(n);

/**
 * A ring segment — the shape almost every non-cinema seating block actually is.
 *
 * Built as outer arc, then inner arc reversed, so the polygon closes without crossing
 * itself. A self-intersecting polygon renders as a bow tie, which is exactly the sort of
 * thing that looks fine in a unit test asserting "four points returned".
 */
function ringSegment(
  centre: Point,
  innerRadius: number,
  outerRadius: number,
  startDeg: number,
  endDeg: number,
  steps = 6,
): Point[] {
  const outer: Point[] = [];
  const inner: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const deg = startDeg + ((endDeg - startDeg) * i) / steps;
    outer.push(polar(centre, outerRadius, deg));
    inner.push(polar(centre, innerRadius, deg));
  }
  return [...outer, ...inner.reverse()];
}

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [
    [round(x), round(y)],
    [round(x + w), round(y)],
    [round(x + w), round(y + h)],
    [round(x), round(y + h)],
  ];
}

/** The average of a polygon's vertices. Good enough for a label on a convex block. */
export function centroid(points: Point[]): Point {
  const sum = points.reduce<[number, number]>((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
  return [round(sum[0] / points.length), round(sum[1] / points.length)];
}

// ── Seat generation ─────────────────────────────────────────────────────────────────

/** A, B, … Z, AA, AB — row labels that keep working past twenty-six rows. */
export function rowLabel(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * Rows of seats for one block.
 *
 * `widen` grows each row towards the back, which is what a block curving away from a stage
 * actually does. Left at 0 for rectangular blocks.
 */
function buildRows(rows: number, seatsPerRow: number, widen = 0): TemplateRow[] {
  return Array.from({ length: rows }, (_, r) => ({
    label: rowLabel(r),
    sortOrder: r,
    seats: Array.from({ length: seatsPerRow + r * widen }, (_, c) => ({
      label: String(c + 1),
      colIndex: c,
      kind: 'SEAT',
    })),
  }));
}

/**
 * Rows with a wheelchair bay and its companion seat at one end of the back row.
 *
 * Every template that generates a ground-level block gets one. A layout that ships with no
 * accessible seating is a layout somebody has to remember to fix, and the evidence is that
 * nobody does until a customer cannot book.
 */
function buildRowsWithAccessibleBay(rows: number, seatsPerRow: number, widen = 0): TemplateRow[] {
  const built = buildRows(rows, seatsPerRow, widen);
  const back = built[built.length - 1];
  if (back && back.seats.length >= 3) {
    back.seats[0] = { ...back.seats[0], kind: 'WHEELCHAIR' };
    back.seats[1] = { ...back.seats[1], kind: 'COMPANION' };
  }
  return built;
}

// ── Templates ───────────────────────────────────────────────────────────────────────

export interface TemplateParams {
  /** Rows in the main block. Every template scales from this. */
  rows?: number;
  /** Seats across the main block. */
  seatsPerRow?: number;
}

/**
 * A cinema: one block facing a screen.
 *
 * Kept as GRID, not SECTIONED, and that is the point — this template exists so the picker
 * can offer "the thing you already had" without special-casing it, and it produces exactly
 * what the old builder produced.
 */
function cinema({ rows = 12, seatsPerRow = 15 }: TemplateParams): GeneratedVenue {
  return {
    layoutKind: 'GRID',
    focalPoint: 'SCREEN',
    focalShape: rect(150, 40, 700, 30),
    focalLabel: 'SCREEN',
    categories: [
      { name: 'Standard', colorHex: '#64748B', sortOrder: 0, priceWeight: 1 },
      { name: 'Premium', colorHex: '#7C3AED', sortOrder: 1, priceWeight: 1.6 },
    ],
    sections: [
      {
        name: 'Main',
        sortOrder: 0,
        shape: rect(150, 140, 700, 700),
        labelX: 500,
        labelY: 490,
        tier: 'FLOOR',
        rotationDeg: 0,
        categoryName: 'Standard',
        rows: buildRowsWithAccessibleBay(rows, seatsPerRow),
      },
    ],
  };
}

/** A theatre: stalls, dress circle, balcony, stage at one end. */
function proscenium({ rows = 14, seatsPerRow = 20 }: TemplateParams): GeneratedVenue {
  const tiers: {
    name: string;
    tier: string;
    category: string;
    y: number;
    h: number;
    rows: number;
  }[] = [
    { name: 'Stalls', tier: 'FLOOR', category: 'Stalls', y: 200, h: 260, rows },
    {
      name: 'Dress circle',
      tier: 'LOWER',
      category: 'Dress circle',
      y: 500,
      h: 180,
      rows: Math.max(4, Math.round(rows * 0.6)),
    },
    {
      name: 'Balcony',
      tier: 'UPPER',
      category: 'Balcony',
      y: 720,
      h: 160,
      rows: Math.max(3, Math.round(rows * 0.45)),
    },
  ];

  return {
    layoutKind: 'SECTIONED',
    focalPoint: 'STAGE_END',
    focalShape: rect(200, 60, 600, 80),
    focalLabel: 'STAGE',
    categories: [
      { name: 'Stalls', colorHex: '#DC2626', sortOrder: 0, priceWeight: 1.8 },
      { name: 'Dress circle', colorHex: '#7C3AED', sortOrder: 1, priceWeight: 1.3 },
      { name: 'Balcony', colorHex: '#0891B2', sortOrder: 2, priceWeight: 1 },
    ],
    sections: tiers.map((t, i) => {
      // Each deck is slightly wider than the one in front, the way a real house steps back.
      const inset = 120 - i * 30;
      const shape = rect(inset, t.y, CANVAS - inset * 2, t.h);
      return {
        name: t.name,
        sortOrder: i,
        shape,
        ...labelFrom(shape),
        tier: t.tier,
        rotationDeg: 0,
        categoryName: t.category,
        rows:
          i === 0
            ? buildRowsWithAccessibleBay(t.rows, seatsPerRow)
            : buildRows(t.rows, seatsPerRow + i * 4),
      };
    }),
  };
}

/** An amphitheatre: wedges fanning out from an end stage. */
function amphitheatre({ rows = 18, seatsPerRow = 16 }: TemplateParams): GeneratedVenue {
  /*
    The fan opens DOWNWARD from a stage at the top.

    Angles here are compass bearings: 0° is straight up, and they increase clockwise, so the
    audience sits between 105° and 255°. Getting this wrong is invisible in any test that
    counts sections — the first version swept 200°–360°, which put half the seating above
    the stage and off the top of the canvas, and every count-based assertion still passed.

    The outer radius is capped so the widest wedge stays inside the square: at 105° a point
    is 500 + R·cos(15°) across, which reaches the right edge at R ≈ 517.
  */
  const stageCentre: Point = [500, 110];
  /*
    Numbered left to right AS DRAWN, which is why the bearings run downwards.

    They were named Left / Left centre / Centre / Right centre / Right, ascending from 105°
    — and 105° is on the map's RIGHT, so every label sat on the opposite side from the block
    it named. Nothing caught it: the geometry was correct, only the words were mirrored, and
    it was visible the moment a real map was rendered and invisible before that.

    Numbering sidesteps the trap rather than restating it. "Left" is ambiguous anyway —
    house-left and stage-left are opposites, and a customer holding a ticket that says
    "Front 2" and looking at a map showing "Front 2" needs neither convention.
  */
  const wedges = Array.from({ length: 5 }, (_unused, i) => ({
    index: i + 1,
    from: 225 - i * 30,
    to: 255 - i * 30,
  }));
  const bands: { label: string; inner: number; outer: number; category: string; tier: string }[] = [
    { label: 'Front', inner: 130, outer: 330, category: 'Front', tier: 'LOWER' },
    { label: 'Rear', inner: 340, outer: 500, category: 'Rear', tier: 'UPPER' },
  ];

  const sections: TemplateSection[] = [];
  bands.forEach((band, bandIndex) => {
    wedges.forEach((wedge, wedgeIndex) => {
      const shape = ringSegment(stageCentre, band.inner, band.outer, wedge.from, wedge.to);
      const midDeg = (wedge.from + wedge.to) / 2;
      sections.push({
        name: `${band.label} ${wedge.index}`,
        sortOrder: bandIndex * wedges.length + wedgeIndex,
        shape,
        ...labelFrom(shape),
        tier: band.tier,
        // Turned to face the stage. A wedge straight below it (bearing 180°) needs no
        // rotation, so the offset is measured from there.
        rotationDeg: round(midDeg - 180),
        categoryName: band.category,
        rows:
          bandIndex === 0 && wedgeIndex === 2
            ? buildRowsWithAccessibleBay(rows, seatsPerRow, 1)
            : buildRows(bandIndex === 0 ? rows : Math.round(rows * 0.8), seatsPerRow, 1),
      });
    });
  });

  return {
    layoutKind: 'SECTIONED',
    focalPoint: 'STAGE_END',
    focalShape: rect(340, 60, 320, 70),
    focalLabel: 'STAGE',
    categories: [
      { name: 'Front', colorHex: '#DC2626', sortOrder: 0, priceWeight: 1.7 },
      { name: 'Rear', colorHex: '#0891B2', sortOrder: 1, priceWeight: 1 },
    ],
    sections,
  };
}

/** An arena: floor blocks inside a lower and an upper bowl. */
function arena({ rows = 20, seatsPerRow = 18 }: TemplateParams): GeneratedVenue {
  const sections: TemplateSection[] = [];

  /*
    Floor blocks — a 2x2 grid in front of the stage, which is at the bottom of the bowl.

    The first version put the stage in the middle of the floor at rect(400, 430, 200, 140)
    and then laid two of the four blocks across it: Floor C and Floor D each overlapped the
    stage by seventy units, so the map drew seating on top of the performance and the word
    STAGE came out half-hidden behind them. Every geometry test passed, because they all
    compared sections with other sections and nothing compared a section with the stage.

    An arena concert seats its floor in FRONT of an end stage, so that is the arrangement:
    blocks from y=320 to y=545, stage from y=560. Both stay inside the lower bowl's inner
    radius of 230 — the furthest corner is 208 from the centre.
  */
  const floor = [
    { name: 'Floor A', x: 395, y: 320 },
    { name: 'Floor B', x: 510, y: 320 },
    { name: 'Floor C', x: 395, y: 440 },
    { name: 'Floor D', x: 510, y: 440 },
  ];
  floor.forEach((block, i) => {
    const shape = rect(block.x, block.y, 95, 105);
    sections.push({
      name: block.name,
      sortOrder: i,
      shape,
      ...labelFrom(shape),
      tier: 'FLOOR',
      rotationDeg: 0,
      categoryName: 'Floor',
      rows: i === 0 ? buildRowsWithAccessibleBay(10, 12) : buildRows(10, 12),
    });
  });

  // Two rings of blocks around the floor. Numbered the way arenas actually number them, so
  // a ticket that says "Lower 104" matches the sign above the tunnel.
  const rings = [
    { prefix: 1, inner: 230, outer: 330, count: 12, category: 'Lower bowl', tier: 'LOWER', rows },
    {
      prefix: 2,
      inner: 350,
      outer: 470,
      count: 16,
      category: 'Upper bowl',
      tier: 'UPPER',
      rows: Math.round(rows * 1.2),
    },
  ];
  rings.forEach((ring) => {
    for (let i = 0; i < ring.count; i++) {
      const from = (360 / ring.count) * i;
      const to = from + 360 / ring.count;
      const shape = ringSegment(CENTRE, ring.inner, ring.outer, from + 1, to - 1);
      const midDeg = (from + to) / 2;
      sections.push({
        name: `${ring.prefix}${String(i + 1).padStart(2, '0')}`,
        sortOrder: 100 * ring.prefix + i,
        shape,
        ...labelFrom(shape),
        tier: ring.tier,
        rotationDeg: round(midDeg),
        categoryName: ring.category,
        rows:
          i === 0
            ? buildRowsWithAccessibleBay(ring.rows, seatsPerRow)
            : buildRows(ring.rows, seatsPerRow),
      });
    }
  });

  return {
    layoutKind: 'SECTIONED',
    focalPoint: 'FIELD',
    // Across the bottom of the bowl, clear of the floor blocks in front of it.
    focalShape: rect(390, 560, 220, 90),
    focalLabel: 'STAGE',
    categories: [
      { name: 'Floor', colorHex: '#DC2626', sortOrder: 0, priceWeight: 2.4 },
      { name: 'Lower bowl', colorHex: '#7C3AED', sortOrder: 1, priceWeight: 1.5 },
      { name: 'Upper bowl', colorHex: '#0891B2', sortOrder: 2, priceWeight: 1 },
    ],
    sections,
  };
}

/** A stadium: four stands and four corners around a pitch. */
function stadium({ rows = 30, seatsPerRow = 26 }: TemplateParams): GeneratedVenue {
  const sections: TemplateSection[] = [];
  const stands = [
    // Short names, because each of these is split into four blocks about ninety units wide
    // and the label is drawn inside one of them. "North stand 1" ran over its neighbour.
    { name: 'North', shape: rect(220, 90, 560, 150), tier: 'LOWER', category: 'Sideline' },
    { name: 'South', shape: rect(220, 760, 560, 150), tier: 'LOWER', category: 'Sideline' },
    { name: 'East', shape: rect(770, 250, 150, 500), tier: 'LOWER', category: 'End' },
    { name: 'West', shape: rect(80, 250, 150, 500), tier: 'LOWER', category: 'End' },
  ];
  stands.forEach((stand, i) => {
    // Split each stand into blocks: a single 8,000-seat polygon is unusable to pick from.
    const blocks = 4;
    const horizontal =
      stand.shape[1][0] - stand.shape[0][0] > stand.shape[2][1] - stand.shape[1][1];
    for (let b = 0; b < blocks; b++) {
      const [x0, y0] = stand.shape[0];
      const w = stand.shape[1][0] - x0;
      const h = stand.shape[2][1] - y0;
      const shape = horizontal
        ? rect(x0 + (w / blocks) * b + 2, y0, w / blocks - 4, h)
        : rect(x0, y0 + (h / blocks) * b + 2, w, h / blocks - 4);
      sections.push({
        name: `${stand.name} ${b + 1}`,
        sortOrder: i * 10 + b,
        shape,
        ...labelFrom(shape),
        tier: stand.tier,
        rotationDeg: horizontal ? 0 : 90,
        categoryName: stand.category,
        rows:
          i === 0 && b === 0
            ? buildRowsWithAccessibleBay(rows, seatsPerRow)
            : buildRows(rows, seatsPerRow),
      });
    }
  });

  /*
    Corners sit in the gaps the four stands leave, and the numbers matter.

    The first placement put them at x 790 and y 180, which pushed the east and north corners
    straight through the stands beside them — two clickable polygons stacked on the same
    pixels, where whichever draws last wins and the other block is unreachable. They now sit
    clear of every stand's bounding box, which is what the overlap test checks.
  */
  const corners: { name: string; at: Point }[] = [
    // Abbreviated because the label is drawn INSIDE a 110-wide block: "North west corner"
    // ran clear across the stand beside it and collided with its label.
    { name: 'NW corner', at: [140, 170] },
    { name: 'NE corner', at: [860, 170] },
    { name: 'SW corner', at: [140, 830] },
    { name: 'SE corner', at: [860, 830] },
  ];
  corners.forEach((corner, i) => {
    const shape = rect(corner.at[0] - 55, corner.at[1] - 45, 110, 90);
    sections.push({
      name: corner.name,
      sortOrder: 200 + i,
      shape,
      ...labelFrom(shape),
      tier: 'UPPER',
      rotationDeg: 0,
      categoryName: 'Corner',
      rows: buildRows(Math.round(rows * 0.6), Math.round(seatsPerRow * 0.7)),
    });
  });

  return {
    layoutKind: 'SECTIONED',
    focalPoint: 'FIELD',
    focalShape: rect(260, 280, 480, 440),
    focalLabel: 'PITCH',
    categories: [
      { name: 'Sideline', colorHex: '#DC2626', sortOrder: 0, priceWeight: 2 },
      { name: 'End', colorHex: '#7C3AED', sortOrder: 1, priceWeight: 1.3 },
      { name: 'Corner', colorHex: '#0891B2', sortOrder: 2, priceWeight: 1 },
    ],
    sections,
  };
}

/** In the round: four blocks surrounding a central stage. */
function inTheRound({ rows = 12, seatsPerRow = 18 }: TemplateParams): GeneratedVenue {
  // Compass letters, not words: the east and west blocks sit side by side across the
  // narrowest part of the map, and "Outer West" and "Ringside West" ran into each other.
  const quadrants = ['N', 'E', 'S', 'W'];
  return {
    layoutKind: 'SECTIONED',
    focalPoint: 'STAGE_CENTRE',
    focalShape: ringSegment(CENTRE, 0, 90, 0, 360, 16),
    focalLabel: 'STAGE',
    categories: [
      { name: 'Ringside', colorHex: '#DC2626', sortOrder: 0, priceWeight: 1.9 },
      { name: 'Outer', colorHex: '#0891B2', sortOrder: 1, priceWeight: 1 },
    ],
    sections: [
      { band: 'Ringside', inner: 110, outer: 240, rowCount: rows },
      { band: 'Outer', inner: 250, outer: 400, rowCount: Math.round(rows * 0.8) },
    ].flatMap((band, bandIndex) =>
      quadrants.map((quadrant, q) => {
        /*
          Each quadrant CENTRED on its compass point, not starting at it.

          Starting at q*90 put North between 2° and 88° — the north-EAST quadrant — so every
          block was drawn a quarter turn from the direction it was named after. Offsetting by
          half a quadrant centres North on 0°, which is straight up, which is where somebody
          reading a map looks for it.
        */
        const from = q * 90 - 43;
        const to = from + 86;
        const shape = ringSegment(CENTRE, band.inner, band.outer, from, to);
        const midDeg = (from + to) / 2;
        return {
          name: `${band.band} ${quadrant}`,
          sortOrder: bandIndex * 4 + q,
          shape,
          ...labelFrom(shape),
          tier: bandIndex === 0 ? 'FLOOR' : 'LOWER',
          rotationDeg: round(midDeg),
          categoryName: band.band,
          rows:
            bandIndex === 0 && q === 0
              ? buildRowsWithAccessibleBay(band.rowCount, seatsPerRow)
              : buildRows(band.rowCount, seatsPerRow),
        };
      }),
    ),
  };
}

/**
 * Where a block's name goes: the average of its outline's vertices.
 *
 * Good enough for every shape these templates produce, including ring segments — with the
 * arc sampled at several points the average lands between the inner and outer edges, not on
 * the chord. It is not good enough in general: an L-shaped or horseshoe block would put its
 * own label outside itself. A test checks every generated section for exactly that, so the
 * day a template grows a concave block, it fails rather than shipping a floating label.
 */
function labelFrom(shape: Point[]): { labelX: number; labelY: number } {
  const [x, y] = centroid(shape);
  return { labelX: x, labelY: y };
}

const GENERATORS: Record<VenueTemplateKey, (p: TemplateParams) => GeneratedVenue> = {
  CINEMA: cinema,
  PROSCENIUM: proscenium,
  AMPHITHEATRE: amphitheatre,
  ARENA: arena,
  STADIUM: stadium,
  IN_THE_ROUND: inTheRound,
};

/** Build a venue from a template. Pure: same input, same map, no database involved. */
export function generateVenue(key: VenueTemplateKey, params: TemplateParams = {}): GeneratedVenue {
  const generator = GENERATORS[key];
  if (!generator) throw new Error(`Unknown venue template: ${key}`);
  return generator(params);
}

/** Total seats a generated venue holds, counting only real seats — never gaps. */
export function seatCount(venue: GeneratedVenue): number {
  return venue.sections.reduce(
    (total, section) =>
      total +
      section.rows.reduce((n, row) => n + row.seats.filter((s) => s.kind !== 'GAP').length, 0),
    0,
  );
}
