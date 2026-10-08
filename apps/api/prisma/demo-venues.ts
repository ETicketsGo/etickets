/**
 * The venues a demonstration is given on.
 *
 * -- WHY A SEPARATE SEED ------------------------------------------------------------------
 * `seed.ts` exists to make the CINEMA path work and is the fixture every cinema regression
 * test leans on. Adding an arena to it would put a 3,500-seat bowl in front of every test
 * that just wants a screen with twelve seats. This builds the places the product is SHOWN
 * with, and nothing else depends on it.
 *
 * Idempotent on venue name, so running it twice does not produce two Demo Arenas.
 *
 *   APP_ENV=LOCAL npx ts-node --transpile-only prisma/demo-venues.ts
 *
 * -- WHAT IT DELIBERATELY IS NOT ----------------------------------------------------------
 * Not a copy of anybody's arena. The names are invented, the geometry is generated from a
 * bowl formula, and no seating chart was traced from a real venue or a competitor's product.
 * What it has to be is CREDIBLE - a court in the middle, a lower ring, an upper ring, real
 * row and seat numbering, aisles, more than one price - so that the product can be judged on
 * whether it reads as professional ticketing software.
 */
import { PrismaClient } from '@prisma/client';
import { assertDestructiveResetAllowed } from './destructive-guard';

const prisma = new PrismaClient();

/** The map's coordinate space. The renderer draws into a 1000x1000 viewBox. */
const VIEW = 1000;
const CX = VIEW / 2;
const CY = VIEW / 2;

type Point = [number, number];

/** A point on an ellipse centred on the court, at `deg` clockwise from twelve o'clock. */
function onEllipse(deg: number, rx: number, ry: number): Point {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [Math.round(CX + rx * Math.cos(rad)), Math.round(CY + ry * Math.sin(rad))];
}

/**
 * One block of a bowl: the quad between an inner and an outer ellipse, over an angle.
 *
 * Interpolated along each arc rather than drawn as a straight-sided quad, because four points
 * makes a bowl look like a cog. Five per edge is enough to read as a curve at map size.
 */
function bowlBlock(
  fromDeg: number,
  toDeg: number,
  inner: [number, number],
  outer: [number, number],
): Point[] {
  const steps = 5;
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    pts.push(onEllipse(fromDeg + ((toDeg - fromDeg) * i) / steps, inner[0], inner[1]));
  }
  for (let i = steps; i >= 0; i -= 1) {
    pts.push(onEllipse(fromDeg + ((toDeg - fromDeg) * i) / steps, outer[0], outer[1]));
  }
  return pts;
}

/** Where to write the block's name: the middle of its own area, not the middle of the map. */
function blockLabel(
  fromDeg: number,
  toDeg: number,
  inner: [number, number],
  outer: [number, number],
): Point {
  return onEllipse((fromDeg + toDeg) / 2, (inner[0] + outer[0]) / 2, (inner[1] + outer[1]) / 2);
}

interface BlockSpec {
  name: string;
  tier: string;
  shape: Point[];
  label: Point;
  rows: number;
  seatsPerRow: number;
  category: string;
  /** Rows at the back of the block where a wheelchair bay and its companion seat sit. */
  accessible?: boolean;
}

/**
 * A ring of blocks around the court.
 *
 * `gapDeg` leaves a vomitory between blocks - the walkway people actually enter through - so
 * the ring reads as a real bowl rather than one continuous band.
 */
function ring(
  count: number,
  inner: [number, number],
  outer: [number, number],
  opts: {
    base: number;
    tier: string;
    rows: number;
    seatsPerRow: number;
    category: string;
    gapDeg: number;
  },
): BlockSpec[] {
  const step = 360 / count;
  return Array.from({ length: count }, (_, i) => {
    const from = i * step + opts.gapDeg / 2;
    const to = (i + 1) * step - opts.gapDeg / 2;
    return {
      /*
        101..110 and 201..212, the way an arena actually numbers its bowl. Concatenating a
        prefix produced "11" and "110" in the same ring, which reads as eleven and one-ten
        and is the sort of detail an operator notices immediately.
      */
      name: String(opts.base + i + 1),
      tier: opts.tier,
      shape: bowlBlock(from, to, inner, outer),
      label: blockLabel(from, to, inner, outer),
      rows: opts.rows,
      seatsPerRow: opts.seatsPerRow,
      category: opts.category,
      // One accessible bay per ring quadrant rather than in every block: that is how a real
      // bowl is built, and scattering them everywhere would be a prettier lie.
      accessible: i % 3 === 0,
    };
  });
}

const ROW_LABELS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split(''); // No I or O: they read as 1 and 0.

/**
 * The organization the demo venues belong to.
 *
 * The EXISTING seeded one, deliberately. Creating a separate "Demo Live" org put the arena
 * somewhere the seeded owner could not see without switching workspaces, so the console
 * showed two cinemas and nothing else - a demonstration that demonstrates nothing. One
 * organizer with a portfolio of places is also closer to the customer being sold to.
 */
async function organization() {
  const seeded = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (seeded) return seeded;
  return prisma.organization.create({
    data: {
      name: 'Demo Live',
      slug: 'demo-live',
      status: 'APPROVED',
      contactEmail: 'hello@demo-live.test',
    },
  });
}

async function venue(
  organizationId: string,
  data: {
    name: string;
    city: string;
    country: string;
    timezone: string;
    region?: string;
    address?: string;
    capacity?: number;
  },
) {
  const found = await prisma.venue.findFirst({ where: { organizationId, name: data.name } });
  if (found) return found;
  return prisma.venue.create({ data: { organizationId, ...data } });
}

async function space(venueId: string, name: string, capacity: number) {
  const found = await prisma.screen.findFirst({ where: { venueId, name } });
  if (found) return found;
  // No cinema. An arena is not one, and it no longer has to pretend to be.
  return prisma.screen.create({ data: { venueId, name, capacity, screenType: '2D' } });
}

/** Build one layout on a space: categories, blocks, rows, seats. */
async function layout(
  screenId: string,
  opts: {
    name: string;
    focalPoint: 'FIELD' | 'STAGE_END' | 'STAGE_CENTRE' | 'SCREEN';
    focalLabel: string;
    focalShape: Point[];
    categories: { name: string; priceMinor: number; colorHex: string }[];
    blocks: BlockSpec[];
    zones?: { name: string; capacity: number; category: string; shape?: Point[]; label?: Point }[];
  },
) {
  const existing = await prisma.seatMap.findFirst({ where: { screenId, name: opts.name } });
  if (existing) return existing;

  const map = await prisma.seatMap.create({
    data: {
      screenId,
      name: opts.name,
      status: 'PUBLISHED',
      publishedAt: new Date(),
      layoutKind: 'SECTIONED',
      focalPoint: opts.focalPoint,
      focalLabel: opts.focalLabel,
      focalShape: opts.focalShape as never,
    },
  });

  const categoryByName = new Map<string, string>();
  for (const [i, c] of opts.categories.entries()) {
    const row = await prisma.seatCategory.create({
      data: {
        seatMapId: map.id,
        name: c.name,
        basePriceMinor: c.priceMinor,
        colorHex: c.colorHex,
        sortOrder: i,
      },
    });
    categoryByName.set(c.name, row.id);
  }

  for (const [i, b] of opts.blocks.entries()) {
    const section = await prisma.seatSection.create({
      data: {
        seatMapId: map.id,
        name: b.name,
        sortOrder: i,
        tier: b.tier,
        shape: b.shape as never,
        labelX: b.label[0],
        labelY: b.label[1],
      },
    });

    const seatCategoryId = categoryByName.get(b.category)!;
    for (let r = 0; r < b.rows; r += 1) {
      const row = await prisma.seatRow.create({
        data: { sectionId: section.id, label: ROW_LABELS[r] ?? `R${r + 1}`, sortOrder: r },
      });

      const seats = [];
      for (let n = 1; n <= b.seatsPerRow; n += 1) {
        /*
          A gangway down the middle of the block. It is not a seat, nobody sits in it, and it
          must not be sellable - counting it would inflate the block's capacity and put a
          ticket in somebody's hand for a place to stand in the aisle.
        */
        const isAisle = n === Math.ceil(b.seatsPerRow / 2);
        // The wheelchair bay sits at the back of the block, where the ramp reaches, with a
        // companion seat beside it.
        const backRow = r === b.rows - 1;
        const isChair = b.accessible && backRow && n === 1;
        const isCompanion = b.accessible && backRow && n === 2;
        seats.push({
          seatMapId: map.id,
          rowId: row.id,
          seatCategoryId,
          label: String(n),
          colIndex: n,
          kind: isAisle ? 'GAP' : isChair ? 'WHEELCHAIR' : isCompanion ? 'COMPANION' : 'SEAT',
        });
      }
      await prisma.seat.createMany({ data: seats });
    }
  }

  for (const [i, z] of (opts.zones ?? []).entries()) {
    await prisma.seatZone.create({
      data: {
        seatMapId: map.id,
        name: z.name,
        capacity: z.capacity,
        categoryId: categoryByName.get(z.category) ?? null,
        sortOrder: i,
        shape: (z.shape ?? null) as never,
        labelX: z.label?.[0] ?? null,
        labelY: z.label?.[1] ?? null,
      },
    });
  }

  return map;
}

/**
 * Put a published event in front of a demo layout, with the same inventory the real
 * scheduling service creates. This script is local-only, but the resulting event deliberately
 * uses the production buyer path: public event -> session -> pinned layout -> booking.
 */
async function demoReservedEvent(opts: {
  organizationId: string;
  venueId: string;
  screenId: string;
  seatMapId: string;
  slug: string;
  title: string;
  category: string;
  currency: string;
  daysFromNow: number;
}) {
  const event = await prisma.event.upsert({
    where: { slug: opts.slug },
    update: {
      venueId: opts.venueId,
      title: opts.title,
      category: opts.category,
      status: 'PUBLISHED',
      publishedAt: new Date(),
    },
    create: {
      organizationId: opts.organizationId,
      venueId: opts.venueId,
      slug: opts.slug,
      title: opts.title,
      category: opts.category,
      description: `A representative ${opts.category.toLowerCase()} event using ETicketsGo's professional reserved-seating flow.`,
      status: 'PUBLISHED',
      publishedAt: new Date(),
      feeMode: 'CUSTOMER_PAYS',
    },
  });

  const now = new Date();
  let session = await prisma.eventSession.findFirst({
    where: { eventId: event.id, seatMapId: opts.seatMapId, startsAt: { gt: now } },
    orderBy: { startsAt: 'asc' },
  });
  if (!session) {
    const startsAt = new Date(now.getTime() + opts.daysFromNow * 24 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 3 * 60 * 60 * 1000);
    session = await prisma.eventSession.create({
      data: {
        eventId: event.id,
        screenId: opts.screenId,
        seatMapId: opts.seatMapId,
        startsAt,
        endsAt,
        status: 'SCHEDULED',
      },
    });
  }

  const categories = await prisma.seatCategory.findMany({
    where: { seatMapId: opts.seatMapId },
    orderBy: { sortOrder: 'asc' },
  });
  const seats = await prisma.seat.findMany({
    where: { seatMapId: opts.seatMapId, kind: { not: 'GAP' } },
    orderBy: [{ rowId: 'asc' }, { colIndex: 'asc' }],
  });
  const zones = await prisma.seatZone.findMany({
    where: { seatMapId: opts.seatMapId },
    orderBy: { sortOrder: 'asc' },
  });

  for (const category of categories) {
    const quantityTotal = seats.filter((seat) => seat.seatCategoryId === category.id).length;
    if (quantityTotal === 0) continue;
    const existing = await prisma.ticketType.findFirst({
      where: { eventSessionId: session.id, seatCategoryId: category.id },
    });
    if (!existing) {
      await prisma.ticketType.create({
        data: {
          eventSessionId: session.id,
          seatCategoryId: category.id,
          name: category.name,
          priceMinor: category.basePriceMinor,
          currency: opts.currency,
          quantityTotal,
          maxPerOrder: 10,
          status: 'ACTIVE',
          inventory: { create: { quantityTotal, quantitySold: 0, quantityHeld: 0 } },
        },
      });
    }
  }

  for (const zone of zones) {
    const category = categories.find((candidate) => candidate.id === zone.categoryId);
    const existing = await prisma.ticketType.findFirst({
      where: {
        eventSessionId: session.id,
        OR: [{ seatZoneId: zone.id }, { name: zone.name }],
      },
    });
    if (existing) {
      await prisma.ticketType.update({
        where: { id: existing.id },
        data: {
          seatZoneId: zone.id,
          seatCategoryId: null,
          name: zone.name,
          priceMinor: category?.basePriceMinor ?? 0,
          currency: opts.currency,
          quantityTotal: zone.capacity,
          inventory: { update: { quantityTotal: zone.capacity } },
        },
      });
    } else {
      await prisma.ticketType.create({
        data: {
          eventSessionId: session.id,
          seatZoneId: zone.id,
          name: zone.name,
          priceMinor: category?.basePriceMinor ?? 0,
          currency: opts.currency,
          quantityTotal: zone.capacity,
          maxPerOrder: 10,
          status: 'ACTIVE',
          inventory: { create: { quantityTotal: zone.capacity } },
        },
      });
    }
    await prisma.showZone.upsert({
      where: { eventSessionId_zoneId: { eventSessionId: session.id, zoneId: zone.id } },
      update: {},
      create: { eventSessionId: session.id, zoneId: zone.id, capacity: zone.capacity },
    });
  }

  await prisma.showSeat.createMany({
    data: seats.map((seat) => ({
      eventSessionId: session!.id,
      seatId: seat.id,
      status: 'AVAILABLE',
    })),
    skipDuplicates: true,
  });

  // A small, stable sample lets the real buyer screen demonstrate unavailable inventory.
  // Never overwrite a hold or sale when this idempotent fixture is re-run.
  const unavailable = seats.filter((seat) => seat.kind === 'SEAT').slice(0, 3);
  await prisma.showSeat.updateMany({
    where: {
      eventSessionId: session.id,
      seatId: { in: unavailable.map((seat) => seat.id) },
      status: 'AVAILABLE',
    },
    data: {
      status: 'BLOCKED',
      overrideKind: 'HOUSE',
      overrideReason: 'Demo house hold',
      overrideAt: new Date(),
    },
  });

  console.log(`    buyer event: /events/${event.slug} -> /shows/${session.id}`);
  return { event, session };
}

/** A rectangle, as the map wants it. */
const rect = (x1: number, y1: number, x2: number, y2: number): Point[] => [
  [x1, y1],
  [x2, y1],
  [x2, y2],
  [x1, y2],
];

async function main() {
  // The same guard the reset uses. This writes a lot of rows and has no business running
  // anywhere but a disposable database.
  // Throws with the reason when the environment is not a disposable one.
  assertDestructiveResetAllowed(process.env);

  const org = await organization();
  console.log(`Organization: ${org.name}`);

  // ---- 1. Demo Arena, United States -----------------------------------------------------
  const arena = await venue(org.id, {
    name: 'Demo Arena',
    city: 'Boise',
    region: 'Idaho',
    country: 'United States',
    timezone: 'America/Boise',
    address: '100 Front Street',
    capacity: 12_000,
  });
  const mainArena = await space(arena.id, 'Main Arena', 12_000);

  const LOWER: [number, number] = [210, 150];
  const LOWER_OUT: [number, number] = [330, 240];
  const UPPER: [number, number] = [350, 260];
  const UPPER_OUT: [number, number] = [470, 360];

  const basketball = await layout(mainArena.id, {
    name: 'Basketball',
    focalPoint: 'FIELD',
    focalLabel: 'COURT',
    focalShape: rect(390, 430, 610, 570),
    categories: [
      { name: 'Courtside', priceMinor: 28_000, colorHex: '#B45309' },
      { name: 'Lower Bowl', priceMinor: 12_500, colorHex: '#1D4ED8' },
      { name: 'Upper Bowl', priceMinor: 5_500, colorHex: '#047857' },
    ],
    blocks: [
      ...ring(10, LOWER, LOWER_OUT, {
        base: 100,
        tier: 'Lower',
        rows: 8,
        seatsPerRow: 15,
        category: 'Lower Bowl',
        gapDeg: 4,
      }),
      ...ring(12, UPPER, UPPER_OUT, {
        base: 200,
        tier: 'Upper',
        rows: 10,
        seatsPerRow: 17,
        category: 'Upper Bowl',
        gapDeg: 3,
      }),
    ],
  });
  console.log('  Demo Arena / Main Arena / Basketball');

  /*
    THE SAME SPACE, A DIFFERENT LAYOUT.

    An end stage occupies one side of the floor, so the blocks behind it have no view and are
    simply NOT IN this layout - which is the honest way to close a section: it does not exist
    for this configuration rather than existing and being disabled. The floor becomes standing
    room, sold by capacity.
  */
  const concert = await layout(mainArena.id, {
    name: 'Concert - End Stage',
    focalPoint: 'STAGE_END',
    focalLabel: 'STAGE',
    focalShape: rect(330, 150, 670, 300),
    categories: [
      { name: 'Floor GA', priceMinor: 9_500, colorHex: '#7C3AED' },
      { name: 'Lower Bowl', priceMinor: 11_000, colorHex: '#1D4ED8' },
      { name: 'Upper Bowl', priceMinor: 4_500, colorHex: '#047857' },
    ],
    blocks: [
      // Blocks 1..7 of ten: the three nearest the stage are behind it and are left out.
      ...ring(10, LOWER, LOWER_OUT, {
        base: 100,
        tier: 'Lower',
        rows: 8,
        seatsPerRow: 15,
        category: 'Lower Bowl',
        gapDeg: 4,
      }).slice(2, 9),
      ...ring(12, UPPER, UPPER_OUT, {
        base: 200,
        tier: 'Upper',
        rows: 10,
        seatsPerRow: 17,
        category: 'Upper Bowl',
        gapDeg: 3,
      }).slice(2, 11),
    ],
    zones: [
      {
        name: 'Floor GA',
        capacity: 1_500,
        category: 'Floor GA',
        shape: rect(395, 330, 605, 560),
        label: [500, 450],
      },
    ],
  });
  console.log('  Demo Arena / Main Arena / Concert - End Stage  (same space, second layout)');
  await demoReservedEvent({
    organizationId: org.id,
    venueId: arena.id,
    screenId: mainArena.id,
    seatMapId: basketball.id,
    slug: 'demo-arena-basketball',
    title: 'Demo Arena Basketball',
    category: 'Sports',
    currency: 'USD',
    daysFromNow: 14,
  });
  await demoReservedEvent({
    organizationId: org.id,
    venueId: arena.id,
    screenId: mainArena.id,
    seatMapId: concert.id,
    slug: 'demo-arena-concert-end-stage',
    title: 'Demo Arena End Stage Concert',
    category: 'Music',
    currency: 'USD',
    daysFromNow: 21,
  });

  // ---- 2. Revolution-style concert hall, United States ----------------------------------
  const hall = await venue(org.id, {
    name: 'Riverbend Concert House',
    city: 'Boise',
    region: 'Idaho',
    country: 'United States',
    timezone: 'America/Boise',
    address: '44 River Street',
    capacity: 1_200,
  });
  const mainHall = await space(hall.id, 'Main Hall', 1_200);
  const gaVip = await layout(mainHall.id, {
    name: 'GA + VIP',
    focalPoint: 'STAGE_END',
    focalLabel: 'STAGE',
    focalShape: rect(300, 120, 700, 250),
    categories: [
      { name: 'VIP', priceMinor: 15_000, colorHex: '#B45309' },
      { name: 'General Admission', priceMinor: 6_500, colorHex: '#1D4ED8' },
    ],
    // No seated blocks at all: this room is standing, and pretending otherwise with rows of
    // fake numbered seats is the thing the zone model exists to avoid.
    blocks: [],
    zones: [
      {
        name: 'VIP Pit',
        capacity: 150,
        category: 'VIP',
        shape: rect(360, 290, 640, 420),
        label: [500, 355],
      },
      {
        name: 'General Admission',
        capacity: 1_050,
        category: 'General Admission',
        shape: rect(250, 440, 750, 820),
        label: [500, 630],
      },
    ],
  });
  console.log('  Riverbend Concert House / Main Hall / GA + VIP');
  await demoReservedEvent({
    organizationId: org.id,
    venueId: hall.id,
    screenId: mainHall.id,
    seatMapId: gaVip.id,
    slug: 'riverbend-ga-vip',
    title: 'Riverbend GA + VIP Concert',
    category: 'Music',
    currency: 'USD',
    daysFromNow: 28,
  });

  // ---- 3. Hyderabad auditorium, India ---------------------------------------------------
  const audVenue = await venue(org.id, {
    name: 'Sai Nilayam Auditorium',
    city: 'Hyderabad',
    region: 'Telangana',
    country: 'India',
    timezone: 'Asia/Kolkata',
    address: 'Road No 12, Banjara Hills',
    capacity: 900,
  });
  const auditorium = await space(audVenue.id, 'Main Auditorium', 900);
  const reservedAuditorium = await layout(auditorium.id, {
    name: 'Reserved Auditorium',
    focalPoint: 'STAGE_END',
    focalLabel: 'STAGE',
    focalShape: rect(320, 110, 680, 230),
    categories: [
      { name: 'Platinum', priceMinor: 50_000, colorHex: '#B45309' },
      { name: 'Gold', priceMinor: 30_000, colorHex: '#1D4ED8' },
      { name: 'Silver', priceMinor: 15_000, colorHex: '#047857' },
    ],
    /*
      Three separated blocks with a staggered balcony above - the shape an Indian auditorium
      actually has, rather than one rectangle. The left and right blocks are angled towards
      the stage, which is why their polygons are not mirror rectangles.
    */
    blocks: [
      {
        name: 'Platinum Centre',
        tier: 'Stalls',
        shape: [
          [420, 300],
          [580, 300],
          [600, 430],
          [400, 430],
        ],
        label: [500, 365],
        rows: 6,
        seatsPerRow: 14,
        category: 'Platinum',
        accessible: true,
      },
      {
        name: 'Gold Left',
        tier: 'Stalls',
        shape: [
          [250, 330],
          [400, 305],
          [385, 440],
          [235, 455],
        ],
        label: [315, 382],
        rows: 6,
        seatsPerRow: 10,
        category: 'Gold',
      },
      {
        name: 'Gold Right',
        tier: 'Stalls',
        shape: [
          [600, 305],
          [750, 330],
          [765, 455],
          [615, 440],
        ],
        label: [685, 382],
        rows: 6,
        seatsPerRow: 10,
        category: 'Gold',
      },
      {
        name: 'Silver Balcony',
        tier: 'Balcony',
        shape: [
          [230, 530],
          [770, 530],
          [800, 700],
          [200, 700],
        ],
        label: [500, 615],
        rows: 8,
        seatsPerRow: 20,
        category: 'Silver',
        accessible: true,
      },
    ],
  });
  console.log('  Sai Nilayam Auditorium / Main Auditorium / Reserved Auditorium');
  await demoReservedEvent({
    organizationId: org.id,
    venueId: audVenue.id,
    screenId: auditorium.id,
    seatMapId: reservedAuditorium.id,
    slug: 'hyderabad-reserved-auditorium',
    title: 'Hyderabad Reserved Auditorium',
    category: 'Theater',
    currency: 'INR',
    daysFromNow: 35,
  });

  // ---- 4. Demo Theater, United States ---------------------------------------------------
  const theatreVenue = await venue(org.id, {
    name: 'Old Mill Theater',
    city: 'Boise',
    region: 'Idaho',
    country: 'United States',
    timezone: 'America/Boise',
    address: '9 Mill Lane',
    capacity: 320,
  });
  const theatre = await space(theatreVenue.id, 'Playhouse', 320);
  const reservedTheatre = await layout(theatre.id, {
    name: 'Reserved Theater',
    focalPoint: 'STAGE_THRUST' as never,
    focalLabel: 'STAGE',
    focalShape: rect(350, 120, 650, 240),
    categories: [
      { name: 'Stalls', priceMinor: 7_500, colorHex: '#1D4ED8' },
      { name: 'Circle', priceMinor: 4_500, colorHex: '#047857' },
    ],
    blocks: [
      {
        name: 'Stalls',
        tier: 'Stalls',
        shape: [
          [300, 300],
          [700, 300],
          [730, 520],
          [270, 520],
        ],
        label: [500, 410],
        rows: 10,
        seatsPerRow: 16,
        category: 'Stalls',
        accessible: true,
      },
      {
        name: 'Circle',
        tier: 'Circle',
        shape: [
          [280, 580],
          [720, 580],
          [745, 730],
          [255, 730],
        ],
        label: [500, 655],
        rows: 6,
        seatsPerRow: 18,
        category: 'Circle',
      },
    ],
  });
  console.log('  Old Mill Theater / Playhouse / Reserved Theater');
  await demoReservedEvent({
    organizationId: org.id,
    venueId: theatreVenue.id,
    screenId: theatre.id,
    seatMapId: reservedTheatre.id,
    slug: 'old-mill-reserved-theater',
    title: 'Old Mill Reserved Theater',
    category: 'Theater',
    currency: 'USD',
    daysFromNow: 42,
  });

  // ---- 5. Canada, for the multi-country gate --------------------------------------------
  const ca = await venue(org.id, {
    name: 'Harbourfront Hall',
    city: 'Toronto',
    region: 'Ontario',
    country: 'Canada',
    timezone: 'America/Toronto',
    address: '12 Queens Quay',
    capacity: 600,
  });
  await space(ca.id, 'Main Room', 600);
  console.log('  Harbourfront Hall / Main Room  (multi-country)');

  const seats = await prisma.seat.count();
  const zones = await prisma.seatZone.count();
  console.log(`\nDemo fixtures ready: ${seats.toLocaleString()} seats, ${zones} standing zones.`);
  console.log('The cinema fixtures from `seed.ts` are untouched.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
