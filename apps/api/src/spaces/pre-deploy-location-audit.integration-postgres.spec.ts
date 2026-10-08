import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * integration-real-postgres - the READ-ONLY pre-deployment location audit.
 *
 * `scripts/pre-deploy-location-audit.sql` is what an authorised operator runs against QA (and
 * later production) before the venue/space migrations deploy. Those environments are on the
 * PRE-migration schema, so this builds the pre-migration shape of the four tables the audit
 * reads, seeds one row of every situation it reports, and runs the audit's own query from the
 * file - not a copy of it.
 *
 * Two properties are asserted, because the procedure promises both:
 *   - it FINDS what it says it finds, including the cross-tenant history that would abort
 *     migration 090000 mid-deploy;
 *   - it CANNOT write: the file contains no data or schema statement, and the transaction it
 *     runs in refuses one at the server.
 *
 * The same file was also run against the full 92-table schema generated from QA's deployed
 * commit; this test keeps the logic verified on every change.
 */
const file = readFileSync(
  resolve(__dirname, '../../scripts/pre-deploy-location-audit.sql'),
  'utf8',
);
const query = file
  .split('-- AUDIT-QUERY-BEGIN')[1]
  .split('-- AUDIT-QUERY-END')[0]
  .trim()
  .replace(/;\s*$/, '');

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(resolve(__dirname, '../../../../.env'), 'utf8');
    return env
      .match(/^DATABASE_URL=(.*)$/m)?.[1]
      .trim()
      .replace(/^['"]|['"]$/g, '');
  } catch {
    return undefined;
  }
}

/** The pre-migration shape: India defaults on Venue, cinemaId required on Screen, no venueId. */
const PRE_MIGRATION = [
  `CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY, "migration_name" TEXT NOT NULL, "finished_at" TIMESTAMPTZ)`,
  `CREATE TABLE "Venue" ("id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "name" TEXT NOT NULL,
     "city" TEXT NOT NULL, "country" TEXT NOT NULL DEFAULT 'India', "region" TEXT,
     "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata', "address" TEXT)`,
  `CREATE TABLE "Cinema" ("id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "venueId" TEXT,
     "name" TEXT NOT NULL, "city" TEXT NOT NULL, "country" TEXT, "region" TEXT,
     "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata', "address" TEXT)`,
  `CREATE TABLE "Screen" ("id" TEXT PRIMARY KEY, "cinemaId" TEXT NOT NULL, "name" TEXT NOT NULL)`,
  `CREATE TABLE "VenueArea" ("id" TEXT PRIMARY KEY, "venueId" TEXT NOT NULL, "name" TEXT NOT NULL)`,
];

interface Row {
  section: string;
  verdict: string;
  entity_id: string | null;
  detail: string;
}

const url = databaseUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip('integration-real-postgres: the read-only pre-deployment location audit', () => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  let seq = 0;

  afterAll(async () => db.$disconnect());

  /** Build the pre-migration tables in an isolated schema, seed, audit read-only, tear down. */
  async function audit(seed: string[]): Promise<Row[]> {
    const schema = `pre_deploy_audit_${process.pid}_${(seq += 1)}`;
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        for (const st of [...PRE_MIGRATION, ...seed]) await tx.$executeRawUnsafe(st);
      });
      return await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        return tx.$queryRawUnsafe<Row[]>(query);
      });
    } finally {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }

  const MIGRATED_UP_TO_QA = `INSERT INTO "_prisma_migrations" VALUES ('m1','20261001194912_settlement_reversal_attempt',NOW())`;

  it('reports nothing to decide for a clean, same-tenant, located database', async () => {
    const rows = await audit([
      MIGRATED_UP_TO_QA,
      `INSERT INTO "Venue" VALUES ('v1','org-a','Hall','Boise','United States','Idaho','America/Boise','1 Main St')`,
      `INSERT INTO "Cinema" VALUES ('c1','org-a','v1','Hall Cinema','Boise','United States','Idaho','America/Boise','1 Main St')`,
      `INSERT INTO "Screen" VALUES ('s1','c1','Screen 1')`,
    ]);
    expect(rows.filter((r) => r.verdict !== 'INFO')).toEqual([]);
    expect(rows.find((r) => r.section === 'F SUMMARY')?.detail).toBe(
      '1 venues, 1 cinemas, 1 screens',
    );
  });

  it('BLOCKS_DEPLOY on exactly the cross-tenant history migration 090000 aborts on', async () => {
    const rows = await audit([
      MIGRATED_UP_TO_QA,
      `INSERT INTO "Venue" VALUES ('v-b','org-b','Their Hall','Toronto','Canada','Ontario','America/Toronto',NULL)`,
      `INSERT INTO "Cinema" VALUES ('c-x','org-a','v-b','Our Cinema','Toronto','Canada','Ontario','America/Toronto',NULL)`,
    ]);
    const blocking = rows.filter((r) => r.verdict === 'BLOCKS_DEPLOY');
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatchObject({ section: 'A CROSS_TENANT', entity_id: 'c-x' });
    expect(blocking[0].detail).toContain('org-a');
    expect(blocking[0].detail).toContain('org-b');
  });

  it('reports the venue a screened cinema will be given, and an unknown country', async () => {
    const rows = await audit([
      MIGRATED_UP_TO_QA,
      `INSERT INTO "Cinema" ("id","organizationId","name","city") VALUES ('c-o','org-a','Orphan','Hyderabad')`,
      `INSERT INTO "Screen" VALUES ('s-o','c-o','Screen 1')`,
      // No screens: the migration leaves it alone, so the audit must too.
      `INSERT INTO "Cinema" ("id","organizationId","name","city") VALUES ('c-empty','org-a','Empty','Pune')`,
    ]);
    const b = rows.filter((r) => r.section === 'B CINEMA_WITHOUT_VENUE');
    expect(b.map((r) => r.entity_id)).toEqual(['c-o']);
    expect(b[0].verdict).toBe('NEEDS_DECISION');
    expect(b[0].detail).toMatch(/country=UNKNOWN/);
  });

  it('reports location conflicts and venues that look defaulted - the Sydney shape', async () => {
    const rows = await audit([
      MIGRATED_UP_TO_QA,
      // Venue never asked: country/timezone are the column DEFAULTS.
      `INSERT INTO "Venue" ("id","organizationId","name","city") VALUES ('v-d','org-a','Defaulted','Sydney')`,
      `INSERT INTO "Cinema" VALUES ('c-s','org-a','v-d','Sydney Cinema','Sydney','Australia',NULL,'Australia/Sydney',NULL)`,
    ]);
    expect(rows.some((r) => r.section === 'C LOCATION_CONFLICT' && r.entity_id === 'c-s')).toBe(
      true,
    );
    const suspect = rows.find((r) => r.section === 'D SUSPECT_DEFAULT');
    expect(suspect).toMatchObject({ verdict: 'NEEDS_DECISION', entity_id: 'v-d' });
    expect(suspect?.detail).toContain('Australia/Sydney');
  });

  it('does not call a same-place venue suspect just because it is in India', async () => {
    // India / Asia/Kolkata is a real answer for a real Indian cinema; only DISAGREEMENT is news.
    const rows = await audit([
      MIGRATED_UP_TO_QA,
      `INSERT INTO "Venue" ("id","organizationId","name","city") VALUES ('v-i','org-a','Indian Hall','Hyderabad')`,
      `INSERT INTO "Cinema" VALUES ('c-i','org-a','v-i','Indian Cinema','Hyderabad','India','Telangana','Asia/Kolkata',NULL)`,
    ]);
    expect(rows.filter((r) => r.section === 'D SUSPECT_DEFAULT')).toEqual([]);
  });

  it('says so when run against a database that has already been migrated', async () => {
    const rows = await audit([
      `INSERT INTO "_prisma_migrations" VALUES ('m2','20261007090000_space_belongs_to_venue',NOW())`,
    ]);
    expect(rows.some((r) => /applied: YES/.test(r.detail))).toBe(true);
  });

  it('cannot write: no data or schema statement in the file, and the server refuses one', async () => {
    /*
      The procedure promises read-only. Asserted twice, because each check catches what the
      other cannot: the static one catches an edit that adds a write; the runtime one proves
      the transaction mode the file opens actually refuses writes on this server.
    */
    const statements = file
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(statements).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(statements).toMatch(/ROLLBACK;\s*$/);
    expect(statements).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|COPY)\b/i,
    );

    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE should_not_exist (id int)`);
      }),
    ).rejects.toThrow(/read-only transaction/i);
  });
});
