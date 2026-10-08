import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const migration = readFileSync(
  resolve(__dirname, '../../prisma/migrations/20261007090000_space_belongs_to_venue/migration.sql'),
  'utf8',
);

/** Split PostgreSQL scripts without splitting semicolons inside strings or DO $$ blocks. */
function statements(sql: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let dollarTag: string | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const pair = sql.slice(i, i + 2);
    if (lineComment) {
      if (sql[i] === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (pair === '*/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (quote) {
      if (sql[i] === quote && sql[i + 1] === quote) {
        i++;
      } else if (sql[i] === quote) {
        quote = null;
      }
      continue;
    }
    if (pair === '--') {
      lineComment = true;
      i++;
      continue;
    }
    if (pair === '/*') {
      blockComment = true;
      i++;
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      quote = sql[i] as "'" | '"';
      continue;
    }
    if (sql[i] === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarTag = match[0];
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (sql[i] === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement) result.push(statement);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync(resolve(__dirname, '../../../../.env'), 'utf8');
  const match = env.match(/^DATABASE_URL=(.*)$/m);
  if (!match) throw new Error('DATABASE_URL is required for the executable migration matrix');
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

const baseSchema = (screenAlreadyHasVenue: boolean) => `
  CREATE TABLE "Venue" (
    "id" TEXT PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'India',
    "region" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
  );
  CREATE TABLE "Cinema" (
    "id" TEXT PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT,
    "region" TEXT,
    "timezone" TEXT,
    "address" TEXT
  );
  CREATE TABLE "Screen" (
    "id" TEXT PRIMARY KEY,
    "cinemaId" TEXT NOT NULL,
    ${screenAlreadyHasVenue ? '"venueId" TEXT,' : ''}
    "name" TEXT NOT NULL
  );
`;

describe('integration-real-postgres: executable space-to-venue migration matrix', () => {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  let sequence = 0;

  async function inSchema<T>(schema: string, run: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      return run(tx as unknown as PrismaClient);
    });
  }

  async function executeScript(tx: PrismaClient, sql: string) {
    for (const statement of statements(sql)) await tx.$executeRawUnsafe(statement);
  }

  async function scenario(
    setup: string,
    assert: (schema: string) => Promise<void>,
    options: { existingScreenVenue?: boolean; migrationFails?: boolean } = {},
  ) {
    const schema = `pr241_matrix_${process.pid}_${sequence++}`;
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await inSchema(schema, async (tx) => {
        await executeScript(tx, baseSchema(Boolean(options.existingScreenVenue)));
        await executeScript(tx, setup);
      });

      const apply = inSchema(schema, async (tx) => {
        await executeScript(tx, migration);
      });
      if (options.migrationFails) {
        await expect(apply).rejects.toThrow(/Cinema\/Venue organization mismatch/);
      } else {
        await apply;
      }
      await assert(schema);
    } finally {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }

  afterAll(async () => db.$disconnect());

  it('A: migrates a known, same-tenant Cinema and Venue', () =>
    scenario(
      `INSERT INTO "Venue" VALUES ('v-a','org-a','Arena','Boise','United States','Idaho','America/Boise',NULL,'ACTIVE',NOW(),NOW());
       INSERT INTO "Cinema" VALUES ('c-a','org-a','v-a','Cinema','Boise','United States','Idaho','America/Boise',NULL);
       INSERT INTO "Screen" VALUES ('s-a','c-a','Main');`,
      async (schema) =>
        inSchema(schema, async (tx) => {
          const rows = await tx.$queryRawUnsafe<Array<{ venueId: string }>>(
            `SELECT "venueId" FROM "Screen" WHERE id='s-a'`,
          );
          expect(rows[0].venueId).toBe('v-a');
        }),
    ));

  it('B: preserves a NULL country when creating an orphan Cinema Venue', () =>
    scenario(
      `INSERT INTO "Cinema" VALUES ('c-b','org-a',NULL,'Unknown Country','Somewhere',NULL,NULL,'UTC',NULL);
       INSERT INTO "Screen" VALUES ('s-b','c-b','Main');`,
      async (schema) =>
        inSchema(schema, async (tx) => {
          const rows = await tx.$queryRawUnsafe<Array<{ country: string | null }>>(
            `SELECT country FROM "Venue" WHERE id='vn_c-b'`,
          );
          expect(rows[0].country).toBeNull();
        }),
    ));

  it('C: preserves a NULL timezone when creating an orphan Cinema Venue', () =>
    scenario(
      `INSERT INTO "Cinema" VALUES ('c-c','org-a',NULL,'Unknown Zone','Somewhere','Canada','Ontario',NULL,NULL);
       INSERT INTO "Screen" VALUES ('s-c','c-c','Main');`,
      async (schema) =>
        inSchema(schema, async (tx) => {
          const rows = await tx.$queryRawUnsafe<Array<{ timezone: string | null }>>(
            `SELECT timezone FROM "Venue" WHERE id='vn_c-c'`,
          );
          expect(rows[0].timezone).toBeNull();
        }),
    ));

  it('D: aborts cross-tenant history and rolls back every schema/data mutation', () =>
    scenario(
      `INSERT INTO "Venue" VALUES ('v-b','org-b','Foreign','Toronto','Canada','Ontario','America/Toronto',NULL,'ACTIVE',NOW(),NOW());
       INSERT INTO "Cinema" VALUES ('c-d','org-a','v-b','Cinema A','Toronto','Canada','Ontario','America/Toronto',NULL);
       INSERT INTO "Screen" VALUES ('s-d','c-d','Main');`,
      async (schema) =>
        inSchema(schema, async (tx) => {
          const columns = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(
            `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='${schema}' AND table_name='Screen' AND column_name='venueId') AS present`,
          );
          const screens = await tx.$queryRawUnsafe<Array<{ cinemaId: string }>>(
            `SELECT "cinemaId" FROM "Screen" WHERE id='s-d'`,
          );
          expect(columns[0].present).toBe(false);
          expect(screens).toEqual([{ cinemaId: 'c-d' }]);
        }),
      { migrationFails: true },
    ));

  it('E: creates a same-tenant Venue for a Cinema without one and copies known location', () =>
    scenario(
      `INSERT INTO "Cinema" VALUES ('c-e','org-a',NULL,'Sydney Hall','Sydney','Australia','New South Wales','Australia/Sydney','1 Harbour St');
       INSERT INTO "Screen" VALUES ('s-e','c-e','Main');`,
      async (schema) =>
        inSchema(schema, async (tx) => {
          const rows = await tx.$queryRawUnsafe<
            Array<{ organizationId: string; country: string; region: string; timezone: string }>
          >(`SELECT "organizationId",country,region,timezone FROM "Venue" WHERE id='vn_c-e'`);
          expect(rows[0]).toEqual({
            organizationId: 'org-a',
            country: 'Australia',
            region: 'New South Wales',
            timezone: 'Australia/Sydney',
          });
        }),
    ));

  it('F: preserves an existing authoritative Screen Venue', () =>
    scenario(
      `INSERT INTO "Venue" VALUES
         ('v-existing','org-a','Existing','Toronto','Canada','Ontario','America/Toronto',NULL,'ACTIVE',NOW(),NOW()),
         ('v-cinema','org-a','Cinema Venue','Toronto','Canada','Ontario','America/Toronto',NULL,'ACTIVE',NOW(),NOW());
       INSERT INTO "Cinema" VALUES ('c-f','org-a','v-cinema','Cinema','Toronto','Canada','Ontario','America/Toronto',NULL);
       INSERT INTO "Screen" VALUES ('s-f','c-f','v-existing','Main');`,
      async (schema) =>
        inSchema(schema, async (tx) => {
          const rows = await tx.$queryRawUnsafe<Array<{ venueId: string }>>(
            `SELECT "venueId" FROM "Screen" WHERE id='s-f'`,
          );
          expect(rows[0].venueId).toBe('v-existing');
        }),
      { existingScreenVenue: true },
    ));

  it('G: preserves authoritative Venue location when Cinema location conflicts', () =>
    scenario(
      `INSERT INTO "Venue" VALUES ('v-g','org-a','Authority','Boise','United States','Idaho','America/Boise',NULL,'ACTIVE',NOW(),NOW());
       INSERT INTO "Cinema" VALUES ('c-g','org-a','v-g','Conflicting Cinema','Hyderabad','India','Telangana','Asia/Kolkata',NULL);
       INSERT INTO "Screen" VALUES ('s-g','c-g','Main');`,
      async (schema) =>
        inSchema(schema, async (tx) => {
          const rows = await tx.$queryRawUnsafe<Array<{ country: string; timezone: string }>>(
            `SELECT country,timezone FROM "Venue" WHERE id='v-g'`,
          );
          expect(rows[0]).toEqual({ country: 'United States', timezone: 'America/Boise' });
        }),
    ));
});
