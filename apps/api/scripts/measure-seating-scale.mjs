/**
 * What actually happens at 500, 2,500, 10,000 and 25,000 seats.
 *
 * -- WHY THIS EXISTS ----------------------------------------------------------------------
 * The platform was built for cinemas, where a big room is 400 seats. Nobody had measured an
 * arena, and "it should be fine" is not a measurement. This builds a real layout at each size
 * in a real database and times the things a buyer and an organizer actually wait for:
 *
 *   build      creating the layout (organizer, once per room)
 *   seats      materialising per-session seat inventory (once per show)
 *   overview   the first buyer read - the map of blocks, no individual seats
 *   section    opening ONE block, which is what a buyer actually picks from
 *
 * It also records the PAYLOAD size of the two buyer reads, because a response that takes 80ms
 * to produce and 4MB to send is not fast - it is slow somewhere the server cannot see.
 *
 * Read-only in the sense that matters: everything it creates is deleted again, under a
 * dedicated organization, in a `finally`.
 *
 *   node apps/api/scripts/measure-seating-scale.mjs
 *   node apps/api/scripts/measure-seating-scale.mjs --sizes 500,2500
 */
import { PrismaClient } from '@prisma/client';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const SIZES = arg('--sizes', '500,2500,10000,25000')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter(Boolean);

const prisma = new PrismaClient();
const ms = (t) => Math.round(Number(process.hrtime.bigint() - t) / 1e6);
const kb = (o) => Math.round(Buffer.byteLength(JSON.stringify(o)) / 1024);

/**
 * A plausible arena bowl: blocks of 500, each 20 rows of 25.
 *
 * Sections matter to the measurement, not just to the picture - the buyer read is sectioned,
 * so a layout that is one enormous block would measure something no real venue has.
 */
function bowl(total) {
  const perSection = 500;
  const sections = Math.max(1, Math.round(total / perSection));
  return Array.from({ length: sections }, (_, i) => ({
    name: `Block ${String(i + 1).padStart(2, '0')}`,
    sortOrder: i,
  }));
}

async function measure(size, orgId, registry) {
  const row = { size };
  // Registered as they are created, so a failure part way through is still recoverable.
  const cleanup = {};
  registry.push(cleanup);
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `Scale ${size}`, city: 'Boise', country: 'United States' },
  });
  cleanup.venueId = venue.id;
  const space = await prisma.screen.create({
    data: { venueId: venue.id, name: `Bowl ${size}`, capacity: size },
  });
  cleanup.spaceId = space.id;

  // ---- build the layout -------------------------------------------------------------
  let t = process.hrtime.bigint();
  const map = await prisma.seatMap.create({
    data: {
      screenId: space.id,
      name: `Arena ${size}`,
      status: 'PUBLISHED',
      layoutKind: 'SECTIONED',
    },
  });
  cleanup.mapId = map.id;
  const category = await prisma.seatCategory.create({
    data: { seatMapId: map.id, name: 'Standard', basePriceMinor: 5_000 },
  });

  const sections = bowl(size);
  let made = 0;
  for (const s of sections) {
    const section = await prisma.seatSection.create({
      data: { seatMapId: map.id, name: s.name, sortOrder: s.sortOrder },
    });
    const rows = [];
    for (let r = 0; r < 20 && made < size; r += 1) {
      rows.push({ sectionId: section.id, label: `R${r + 1}`, sortOrder: r });
      made += Math.min(25, size - made);
    }
    await prisma.seatRow.createMany({ data: rows });
    const created = await prisma.seatRow.findMany({
      where: { sectionId: section.id },
      select: { id: true },
    });
    const seats = [];
    for (const rr of created) {
      for (let n = 1; n <= 25; n += 1) {
        seats.push({
          seatMapId: map.id,
          rowId: rr.id,
          seatCategoryId: category.id,
          label: String(n),
          colIndex: n,
          kind: 'SEAT',
        });
      }
    }
    // `createMany` in one statement per section: row-at-a-time inserts are the usual reason
    // a big layout feels impossible, and measuring that instead would measure the wrong thing.
    await prisma.seat.createMany({ data: seats });
  }
  row.buildMs = ms(t);
  row.seats = await prisma.seat.count({ where: { seatMapId: map.id } });

  // ---- per-session seat inventory ---------------------------------------------------
  const event = await prisma.event.create({
    data: {
      organizationId: orgId,
      venueId: venue.id,
      title: `Scale ${size}`,
      slug: `scale-${size}-${Date.now()}`,
      category: 'Music',
    },
  });
  cleanup.eventId = event.id;
  const session = await prisma.eventSession.create({
    data: {
      eventId: event.id,
      screenId: space.id,
      seatMapId: map.id,
      startsAt: new Date(Date.now() + 30 * 86_400_000),
      endsAt: new Date(Date.now() + 30 * 86_400_000 + 3 * 3_600_000),
    },
  });

  const allSeats = await prisma.seat.findMany({
    where: { seatMapId: map.id },
    select: { id: true },
  });
  t = process.hrtime.bigint();
  await prisma.showSeat.createMany({
    data: allSeats.map((s) => ({ eventSessionId: session.id, seatId: s.id })),
  });
  row.showSeatsMs = ms(t);

  // ---- the two buyer reads ----------------------------------------------------------
  // The OVERVIEW: blocks and counts, no individual seats. What a buyer sees first.
  t = process.hrtime.bigint();
  const overview = await prisma.seatSection.findMany({
    where: { seatMapId: map.id },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      name: true,
      _count: { select: { rows: true } },
    },
  });
  row.overviewMs = ms(t);
  row.overviewKb = kb(overview);
  row.sections = overview.length;

  // ONE block, with its seats and their per-show status. What a buyer picks from.
  const firstSection = overview[0];
  t = process.hrtime.bigint();
  const block = await prisma.seat.findMany({
    where: { seatMapId: map.id, row: { sectionId: firstSection.id } },
    select: {
      id: true,
      label: true,
      kind: true,
      row: { select: { label: true } },
      seatCategory: { select: { name: true, basePriceMinor: true } },
      showSeats: { where: { eventSessionId: session.id }, select: { status: true } },
    },
  });
  row.sectionMs = ms(t);
  row.sectionKb = kb(block);
  row.sectionSeats = block.length;

  // What the WHOLE map would cost, if anything ever asked for it in one go. Measured so the
  // number exists rather than being assumed survivable.
  t = process.hrtime.bigint();
  const everything = await prisma.seat.findMany({
    where: { seatMapId: map.id },
    select: {
      id: true,
      label: true,
      kind: true,
      row: { select: { label: true, section: { select: { name: true } } } },
      showSeats: { where: { eventSessionId: session.id }, select: { status: true } },
    },
  });
  row.wholeMapMs = ms(t);
  row.wholeMapKb = kb(everything);

  return {
    row,
    cleanup: { venueId: venue.id, mapId: map.id, eventId: event.id, spaceId: space.id },
  };
}

const results = [];
const org = await prisma.organization.create({
  data: { name: `ScaleBench ${Date.now()}`, slug: `scalebench-${Date.now()}` },
});

/**
 * Everything this run created, so a crash can still take it away.
 *
 * The first version cleaned up only after a size SUCCEEDED. A run that threw part way left a
 * venue-less space called `Bowl 500` behind in the development database, which then appeared
 * as a real violation in the space audit. A measurement has to be able to fail without
 * leaving evidence that looks like a defect in the product.
 */
const registry = [];

async function discard(c) {
  if (!c) return;
  await prisma.showSeat.deleteMany({ where: { seat: { seatMapId: c.mapId } } }).catch(() => {});
  await prisma.eventSession.deleteMany({ where: { eventId: c.eventId } }).catch(() => {});
  await prisma.event.deleteMany({ where: { id: c.eventId } }).catch(() => {});
  await prisma.seat.deleteMany({ where: { seatMapId: c.mapId } }).catch(() => {});
  await prisma.seatRow.deleteMany({ where: { section: { seatMapId: c.mapId } } }).catch(() => {});
  await prisma.seatSection.deleteMany({ where: { seatMapId: c.mapId } }).catch(() => {});
  await prisma.seatCategory.deleteMany({ where: { seatMapId: c.mapId } }).catch(() => {});
  await prisma.seatMap.deleteMany({ where: { id: c.mapId } }).catch(() => {});
  await prisma.screen.deleteMany({ where: { id: c.spaceId } }).catch(() => {});
  await prisma.venue.deleteMany({ where: { id: c.venueId } }).catch(() => {});
}

try {
  for (const size of SIZES) {
    process.stdout.write(`measuring ${size}... `);
    // `measure` registers each row in `made` AS it creates it, so a throw half way through
    // is still recoverable by the `finally` below.
    const { row, cleanup } = await measure(size, org.id, registry);
    results.push(row);
    process.stdout.write(`done (${row.buildMs}ms build)
`);
    await discard(cleanup);
    registry.splice(registry.indexOf(cleanup), 1);
  }
} finally {
  for (const c of registry) await discard(c);
  await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => undefined);
  // A space with no venue is the one thing this must never leave behind: it is
  // indistinguishable from the defect the space audit exists to find.
  const stranded = await prisma.screen.count({ where: { venueId: null } }).catch(() => 0);
  if (stranded > 0)
    console.error(`
!! ${stranded} space(s) left with no venue - clean up.`);
}

console.log('\nseats  sect  build    showSeats  overview        section            whole map');
for (const r of results) {
  console.log(
    `${String(r.seats).padStart(6)} ${String(r.sections).padStart(5)} ` +
      `${String(r.buildMs + 'ms').padStart(8)} ${String(r.showSeatsMs + 'ms').padStart(10)}  ` +
      `${String(r.overviewMs + 'ms').padStart(6)}/${String(r.overviewKb + 'kb').padStart(6)}  ` +
      `${String(r.sectionMs + 'ms').padStart(6)}/${String(r.sectionKb + 'kb').padStart(6)} (${r.sectionSeats})  ` +
      `${String(r.wholeMapMs + 'ms').padStart(7)}/${String(r.wholeMapKb + 'kb').padStart(7)}`,
  );
}

await prisma.$disconnect();
