/**
 * Which venues keep a clock their state does not?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Until the venue form learned to set the zone from the state, every United States venue was
 * saved on the country's first zone, America/New_York - a Meridian, Idaho venue on QA among
 * them. The form is fixed; the rows it already wrote are not, and this does NOT fix them. A
 * venue's zone times every show sold there, so moving it is a decision for a person who can
 * see which shows would change, not for a script.
 *
 * It lists, for the owner, every venue and cinema whose stored zone keeps a different CLOCK
 * from the one its state keeps (`REGION_TIMEZONES` in shared-types), with the shows still to
 * come that would be affected. America/Denver for a Boise venue is a different name for the
 * same clock and is not listed: no show time there reads wrong. A row can still be legitimate -
 * El Paso is in Texas and keeps Mountain time - so the list is a question to ask, not a list of
 * mistakes.
 *
 *   npm run build --workspace @eticketsgo/shared-types
 *   DATABASE_URL=<read-only or ordinary URL> node scripts/ops/venue-timezone-audit.mjs [--json]
 *
 * SELECTs only. It writes nothing and prints no credential.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { regionZone, sameClock, zoneInWords } = require('@eticketsgo/shared-types');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
const asJson = process.argv.includes('--json');
const prisma = new PrismaClient();

try {
  const now = new Date();
  const venues = await prisma.venue.findMany({
    select: {
      id: true,
      name: true,
      city: true,
      country: true,
      region: true,
      timezone: true,
      organization: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const cinemas = await prisma.cinema.findMany({
    select: {
      id: true,
      name: true,
      city: true,
      country: true,
      region: true,
      timezone: true,
      venueId: true,
      organization: { select: { name: true } },
    },
  });

  const rows = [];
  for (const v of venues) {
    const expected = regionZone(v.country, v.region);
    if (!expected || (v.timezone && sameClock(v.timezone, expected))) continue;
    const upcoming = await prisma.eventSession.count({
      where: { event: { venueId: v.id }, startsAt: { gte: now } },
    });
    rows.push({ kind: 'venue', ...v, organization: v.organization?.name, expected, upcoming });
  }
  for (const c of cinemas) {
    const expected = regionZone(c.country, c.region);
    if (!expected || (c.timezone && sameClock(c.timezone, expected))) continue;
    rows.push({
      kind: 'cinema',
      ...c,
      organization: c.organization?.name,
      expected,
      upcoming: null,
    });
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(
      `Checked ${venues.length} venues and ${cinemas.length} cinemas. ${rows.length} keep a zone their state does not.`,
    );
    for (const r of rows) {
      console.log(
        [
          `- ${r.kind} "${r.name}" (${r.city}, ${r.region}, ${r.country}) - ${r.organization ?? 'no organization'}`,
          `    id ${r.id}`,
          `    stored:   ${r.timezone ?? '(none)'}${r.timezone ? ` = ${zoneInWords(r.timezone)}` : ''}`,
          `    expected: ${r.expected} = ${zoneInWords(r.expected)}`,
          r.upcoming === null ? null : `    upcoming sessions affected: ${r.upcoming}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
  }
} finally {
  await prisma.$disconnect();
}
