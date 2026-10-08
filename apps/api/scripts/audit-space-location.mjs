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

  /*
    Venues whose location may be a DEFAULT rather than an answer.

    `Venue.country` defaulted to 'India' and `Venue.timezone` to 'Asia/Kolkata' until the
    column defaults were dropped. Every row written before that holds a value, and the data
    cannot say whether anybody supplied it. These are the rows a human has to look at before
    any backfill: the venue says India, and its own cinemas - whose zone IS written from what
    the operator chose - say something else.

    Reported, never corrected. Guessing here is the defect the whole change removes.
  */
  const suspect = await prisma.$queryRawUnsafe(
    `SELECT v."id", v."name", v."city", v."country" AS venue_country,
            v."timezone" AS venue_timezone,
            MIN(c."timezone") AS cinema_timezone,
            COUNT(DISTINCT c."timezone")::int AS distinct_cinema_zones
       FROM "Venue" v
       JOIN "Cinema" c ON c."venueId" = v."id"
      WHERE v."timezone" = 'Asia/Kolkata'
        AND c."timezone" <> 'Asia/Kolkata'
      GROUP BY v."id", v."name", v."city", v."country", v."timezone"`,
  );

  const venues = await prisma.venue.count();
  const areas = await prisma.venueArea.count();

  /*
    The space-level invariant, which lives here rather than in a test.

    It was briefly asserted in the integration suite and reported 17 offending rows - all of
    them created moments earlier by other fixtures calling `prisma.screen.create` directly.
    A global data invariant cannot be checked from inside the suite that is writing the data.
    Here it sees a settled environment, which is the only place the answer means anything.
  */
  const [{ present: screenVenueColumnPresent }] = await prisma.$queryRawUnsafe(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'Screen'
          AND column_name = 'venueId'
     ) AS present`,
  );
  /* The audit is intentionally runnable both before and after the migration. */
  const spacesWithNoVenue = screenVenueColumnPresent
    ? await prisma.screen.findMany({
        where: { venueId: null },
        select: { id: true, name: true, cinemaId: true },
      })
    : [];
  const spacesDisagreeing = screenVenueColumnPresent
    ? await prisma.$queryRawUnsafe(
        `SELECT s."id", s."name", s."venueId" AS space_venue, c."venueId" AS cinema_venue
           FROM "Screen" s
           JOIN "Cinema" c ON s."cinemaId" = c."id"
          WHERE c."venueId" IS NOT NULL
            AND s."venueId" IS DISTINCT FROM c."venueId"`,
      )
    : [];
  /*
    Ownership mismatches are categorically different from location disagreements. They are
    not candidates for inheritance or backfill: they are tenant-boundary corruption, and the
    migration deliberately aborts while any exist.
  */
  const cinemaVenueOrganizationMismatches = await prisma.$queryRawUnsafe(
    `SELECT c."id" AS cinema_id, c."name" AS cinema_name,
            c."organizationId" AS cinema_organization_id,
            v."id" AS venue_id, v."organizationId" AS venue_organization_id
       FROM "Cinema" c
       JOIN "Venue" v ON v."id" = c."venueId"
      WHERE c."organizationId" <> v."organizationId"
      ORDER BY c."id"`,
  );
  const screenOrganizationMismatches = screenVenueColumnPresent
    ? await prisma.$queryRawUnsafe(
        `SELECT s."id" AS screen_id, s."name" AS screen_name,
            s."venueId" AS screen_venue_id,
            sv."organizationId" AS screen_venue_organization_id,
            c."id" AS cinema_id, c."organizationId" AS cinema_organization_id,
            c."venueId" AS cinema_venue_id,
            cv."organizationId" AS cinema_venue_organization_id
       FROM "Screen" s
       LEFT JOIN "Venue" sv ON sv."id" = s."venueId"
       LEFT JOIN "Cinema" c ON c."id" = s."cinemaId"
       LEFT JOIN "Venue" cv ON cv."id" = c."venueId"
      WHERE (c."id" IS NOT NULL AND sv."organizationId" IS DISTINCT FROM c."organizationId")
         OR (cv."id" IS NOT NULL AND cv."organizationId" IS DISTINCT FROM c."organizationId")
         OR (sv."id" IS NOT NULL AND cv."id" IS NOT NULL
             AND sv."organizationId" IS DISTINCT FROM cv."organizationId")
      ORDER BY s."id"`,
      )
    : [];
  const venuesWithUnknownLocation = await prisma.venue.findMany({
    where: { OR: [{ country: null }, { timezone: null }] },
    select: { id: true, name: true, city: true, country: true, region: true, timezone: true },
    orderBy: { createdAt: 'asc' },
  });

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
    screenVenueColumnPresent,
    cinemaVenueOrganizationMismatches,
    screenOrganizationMismatches,
    venuesWithUnknownLocation,
    suspectVenues: suspect,
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

    console.log(
      `cinema/venue organization mismatches: ${cinemaVenueOrganizationMismatches.length}`,
    );
    for (const r of cinemaVenueOrganizationMismatches) {
      console.log(
        `  ${r.cinema_name} (${r.cinema_id}) cinemaOrg=${r.cinema_organization_id} ` +
          `venue=${r.venue_id} venueOrg=${r.venue_organization_id}`,
      );
    }
    console.log(`screen ownership mismatches: ${screenOrganizationMismatches.length}`);
    for (const r of screenOrganizationMismatches) {
      console.log(
        `  ${r.screen_name} (${r.screen_id}) screenVenue=${r.screen_venue_id ?? '-'} ` +
          `screenVenueOrg=${r.screen_venue_organization_id ?? '-'} cinema=${r.cinema_id ?? '-'} ` +
          `cinemaOrg=${r.cinema_organization_id ?? '-'} cinemaVenue=${r.cinema_venue_id ?? '-'} ` +
          `cinemaVenueOrg=${r.cinema_venue_organization_id ?? '-'}`,
      );
    }
    console.log(`venues with unknown country or timezone: ${venuesWithUnknownLocation.length}`);
    for (const r of venuesWithUnknownLocation) {
      console.log(
        `  ${r.name} (${r.id}) ${r.city} country=${r.country ?? '-'} ` +
          `region=${r.region ?? '-'} timezone=${r.timezone ?? '-'}`,
      );
    }

    console.log(`
venues whose zone looks DEFAULTED, not answered: ${suspect.length}`);
    for (const r of suspect) {
      console.log(
        `  ${r.name} (${r.id}) ${r.city} - venue says ${r.venue_timezone}, ` +
          `its cinemas say ${r.cinema_timezone}` +
          (r.distinct_cinema_zones > 1 ? ` (and ${r.distinct_cinema_zones} different zones)` : ''),
      );
    }
    if (suspect.length) {
      console.log(
        '  ^ these need a HUMAN decision before any backfill. Nothing is corrected here.',
      );
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
    spacesDisagreeing.length > 0 ||
    cinemaVenueOrganizationMismatches.length > 0 ||
    screenOrganizationMismatches.length > 0 ||
    venuesWithUnknownLocation.length > 0 ||
    suspect.length > 0
      ? 2
      : 0;
} finally {
  await prisma.$disconnect();
}
