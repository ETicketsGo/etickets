/**
 * Read-only census of the cinema pricing policy table.
 *
 * Exists so "how many rows are ACTIVE in this environment?" can be answered from inside the
 * private network without a psql session, a public database proxy, or an admin login. It
 * writes nothing and takes no flags, so it is safe to point any environment at it.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const rows = await prisma.cinemaPricingPolicy.groupBy({
    by: ['country', 'region', 'status'],
    _count: { _all: true },
    orderBy: [{ country: 'asc' }, { region: 'asc' }, { status: 'asc' }],
  });

  const docs = await prisma.regulatoryDocument.findMany({
    select: { reference: true, region: true, textReviewed: true },
    orderBy: { reference: 'asc' },
  });

  console.log('POLICY CENSUS');
  if (rows.length === 0) console.log('  (no cinema pricing policies in this database)');
  for (const r of rows) {
    console.log(`  ${r.country} / ${r.region.padEnd(18)} ${r.status.padEnd(10)} ${r._count._all}`);
  }

  console.log('\nREGULATORY DOCUMENTS');
  if (docs.length === 0) console.log('  (none)');
  for (const d of docs) {
    // textReviewed is printed on every line because it is the difference between a value
    // somebody read in the order and a value somebody copied from a summary of it.
    console.log(`  [${d.textReviewed ? 'reviewed' : 'UNREVIEWED'}] ${d.region} — ${d.reference}`);
  }

  const active = await prisma.cinemaPricingPolicy.count({ where: { status: 'ACTIVE' } });
  console.log(`\nACTIVE TOTAL: ${active}`);

  /*
    A census of the entities a restore is supposed to bring back.

    Printed by the READ-ONLY operation on purpose, so the same command answers "what is in
    here?" before a reset and "did it come back?" afterwards. Comparing two runs of one
    read-only command is much harder to fool than a restore that reports its own success.
  */
  const counts: [string, Promise<number>][] = [
    ['users', prisma.user.count()],
    ['organizations', prisma.organization.count()],
    ['venues', prisma.venue.count()],
    ['cinemas', prisma.cinema.count()],
    ['screens', prisma.screen.count()],
    ['seat maps', prisma.seatMap.count()],
    ['seat categories', prisma.seatCategory.count()],
    ['movies', prisma.movie.count()],
    ['events', prisma.event.count()],
    ['sessions (shows)', prisma.eventSession.count()],
    ['ticket types', prisma.ticketType.count()],
    ['bookings', prisma.booking.count()],
    ['payments', prisma.payment.count()],
    ['tax rules', prisma.taxRule.count()],
    ['fee rules', prisma.feeRule.count()],
    ['payment provider configs', prisma.paymentProviderConfig.count()],
    ['payment routes', prisma.paymentRoute.count()],
  ];
  console.log('\nENTITY CENSUS');
  const resolved: Record<string, number> = {};
  for (const [label, pending] of counts) {
    resolved[label] = await pending;
    console.log(`  ${label.padEnd(26)} ${resolved[label]}`);
  }

  /*
    The same census again, on ONE line.

    Railway's log API returns lines unordered and sometimes incompletely, so a multi-line
    report read back from a deployment's logs cannot be trusted — reading one produced a
    partial census that silently omitted most of the entities and would have been mistaken for
    a half-restored database. A single line either arrives whole or does not arrive at all, and
    a caller can parse it rather than hoping the ordering held.
  */
  console.log(
    `CENSUS_JSON ${JSON.stringify({
      policies: Object.fromEntries(rows.map((r) => [`${r.region}/${r.status}`, r._count._all])),
      activeTotal: active,
      entities: resolved,
    })}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
