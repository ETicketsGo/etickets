/**
 * Where does a space think it is, and where does its venue think it is?
 *
 * -- WHY THIS EXISTS ----------------------------------------------------------------------
 * `Cinema` (the space) carries its own `city`, `address`, `country`, `region` and `timezone`
 * alongside `Venue`'s, and `venueId` is optional. So the two rows can disagree, and nothing
 * in the schema arbitrates. Making `Venue` authoritative means deciding what happens to every
 * row that already disagrees - and that decision has to be made against REAL data, in each
 * environment, rather than assumed from the local seed.
 *
 * Run it before the migration and again after. It writes nothing.
 *
 *   node apps/api/scripts/audit-space-location.mjs            # human summary
 *   node apps/api/scripts/audit-space-location.mjs --json     # machine readable
 *
 * It reads DATABASE_URL from the environment, so point it at QA or production the same way
 * any other read-only tool is pointed at them.
 */
import { PrismaClient } from '@prisma/client';

/** The fields a space duplicates from its venue. `district` and `localBodyType` are NOT here:
 *  they are genuinely space-level regulatory facts with no venue equivalent. */
const DUPLICATED = ['city', 'country', 'region', 'timezone', 'address'];

const asJson = process.argv.includes('--json');

const prisma = new PrismaClient();

try {
  const spaces = await prisma.cinema.findMany({
    include: { venue: true, screens: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const orphans = [];
  const conflicts = [];
  let agree = 0;

  for (const s of spaces) {
    if (!s.venueId || !s.venue) {
      /*
        A space with no venue is the harder case. It is not a disagreement - it is a space
        that has nowhere to inherit FROM, so the migration has to create a venue for it out
        of the location it is already carrying.
      */
      orphans.push({
        id: s.id,
        name: s.name,
        organizationId: s.organizationId,
        screens: s.screens.length,
        carries: Object.fromEntries(DUPLICATED.map((f) => [f, s[f] ?? null])),
      });
      continue;
    }

    const differing = [];
    for (const f of DUPLICATED) {
      const mine = s[f] ?? null;
      const theirs = s.venue[f] ?? null;
      // Only a real disagreement counts. A null on either side is an absence, not a conflict:
      // there is nothing to choose between, so inheritance resolves it without a decision.
      if (mine !== null && theirs !== null && String(mine) !== String(theirs)) {
        differing.push({ field: f, space: mine, venue: theirs });
      }
    }
    if (differing.length) {
      conflicts.push({
        id: s.id,
        name: s.name,
        venueId: s.venueId,
        venueName: s.venue.name,
        screens: s.screens.length,
        differing,
      });
    } else {
      agree++;
    }
  }

  const venues = await prisma.venue.count();
  const areas = await prisma.venueArea.count();

  /*
    The space-level invariant, which lives here rather than in a test.

    It was briefly asserted in the integration suite and reported 17 offending rows - all of
    them created moments earlier by other fixtures calling `prisma.screen.create` directly.
    A global data invariant cannot be checked from inside the suite that is writing the data.
    Here it sees a settled environment, which is the only place the answer means anything.
  */
  const spacesWithNoVenue = await prisma.screen.findMany({
    where: { venueId: null },
    select: { id: true, name: true, cinemaId: true },
  });
  const spacesDisagreeing = await prisma.$queryRawUnsafe(
    `SELECT s."id", s."name", s."venueId" AS space_venue, c."venueId" AS cinema_venue
       FROM "Screen" s
       JOIN "Cinema" c ON s."cinemaId" = c."id"
      WHERE c."venueId" IS NOT NULL
        AND s."venueId" IS DISTINCT FROM c."venueId"`,
  );

  const report = {
    spaces: spaces.length,
    venues,
    venueAreas: areas,
    agree,
    conflicts: conflicts.length,
    orphans: orphans.length,
    conflictRows: conflicts,
    orphanRows: orphans,
    spacesWithNoVenue,
    spacesDisagreeing,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`spaces=${report.spaces}  venues=${venues}  venueAreas=${areas}`);
    console.log(`  agree with their venue : ${agree}`);
    console.log(`  DISAGREE               : ${conflicts.length}`);
    console.log(`  no venue at all        : ${orphans.length}`);
    if (conflicts.length) {
      console.log('\n-- spaces that disagree with their venue --');
      for (const c of conflicts) {
        console.log(`  ${c.name} (${c.id}) in venue ${c.venueName}, ${c.screens} screen(s)`);
        for (const d of c.differing) {
          console.log(`      ${d.field}: space="${d.space}" venue="${d.venue}"`);
        }
      }
    }
    if (orphans.length) {
      console.log('\n-- spaces with no venue (a venue must be created for each) --');
      for (const o of orphans) {
        const where = DUPLICATED.map((f) => `${f}=${o.carries[f] ?? '-'}`).join(' ');
        console.log(`  ${o.name} (${o.id}) ${o.screens} screen(s)  ${where}`);
      }
    }
    console.log(`
spaces (Screen) with no venue : ${spacesWithNoVenue.length}`);
    for (const r of spacesWithNoVenue) {
      console.log(`  ${r.name} (${r.id}) cinemaId=${r.cinemaId ?? '-'}`);
    }
    console.log(`spaces disagreeing with their cinema's venue: ${spacesDisagreeing.length}`);
    for (const r of spacesDisagreeing) {
      console.log(`  ${r.name} (${r.id}) space=${r.space_venue} cinema=${r.cinema_venue}`);
    }

    // `venueArea` is expected to be 0 everywhere. If it is not, the "it is dead" finding is
    // wrong in THIS environment and the table cannot simply be dropped.
    if (areas > 0) {
      console.log(`\n!! venueArea has ${areas} row(s) here. It is not dead in this database.`);
    }
  }

  // A non-zero exit is reserved for "this environment needs decisions before the migration",
  // so a pipeline can gate on it. Agreement alone is not interesting enough to fail on.
  process.exitCode =
    conflicts.length > 0 ||
    orphans.length > 0 ||
    spacesWithNoVenue.length > 0 ||
    spacesDisagreeing.length > 0
      ? 2
      : 0;
} finally {
  await prisma.$disconnect();
}
