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
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
