import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { leastPrivilegeStatements, printable, scramVerifier } from '../../prisma/db-roles';

/**
 * The least-privilege logins against a real Postgres: the app role can do everything the running
 * platform does with ROWS and nothing it must never do with STRUCTURE, roles or the migration
 * history; the read-only role cannot write at all; and a table created by a LATER migration is
 * covered without anybody remembering to grant. The password is set from a SCRAM verifier, and
 * the test logs in with the plaintext, so the verifier format is proven by Postgres itself.
 *
 * Uses throwaway role names and drops everything it created.
 */
const suffix = randomBytes(4).toString('hex');
const APP = `etg_app_t${suffix}`;
const RO = `etg_ro_t${suffix}`;
const PROBE = `lp_probe_${suffix}`;
const appPw = randomBytes(24).toString('base64url');
const roPw = randomBytes(24).toString('base64url');

const owner = new PrismaClient();
let app: PrismaClient;
let ro: PrismaClient;

const as = (role: string, pw: string) => {
  const u = new URL(process.env.DATABASE_URL!);
  u.username = role;
  u.password = pw;
  return new PrismaClient({ datasources: { db: { url: u.toString() } } });
};
const fails = async (p: Promise<unknown>, pattern: RegExp) => {
  await expect(p).rejects.toThrow(pattern);
};
const DENIED =
  /permission denied|must be owner|must be superuser|read-only transaction|42501|25006/i;

beforeAll(async () => {
  const [{ owner: who, database }] = await owner.$queryRaw<{ owner: string; database: string }[]>`
    SELECT current_user AS owner, current_database() AS database`;
  for (const st of leastPrivilegeStatements({
    owner: who,
    database,
    appRole: APP,
    readonlyRole: RO,
    appPasswordVerifier: scramVerifier(appPw),
    readonlyPasswordVerifier: scramVerifier(roPw),
  })) {
    await owner.$executeRawUnsafe(st);
  }
  // Running them twice must be harmless (the operation is re-run on every environment).
  for (const st of leastPrivilegeStatements({
    owner: who,
    database,
    appRole: APP,
    readonlyRole: RO,
  })) {
    await owner.$executeRawUnsafe(st);
  }
  // A table created by a FUTURE migration, i.e. by the owner after the grants.
  await owner.$executeRawUnsafe(`CREATE TABLE "${PROBE}" (id serial PRIMARY KEY, note text)`);
  app = as(APP, appPw);
  ro = as(RO, roPw);
});

afterAll(async () => {
  await app?.$disconnect();
  await ro?.$disconnect();
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "${PROBE}"`);
  for (const r of [APP, RO]) {
    await owner.$executeRawUnsafe(`DROP OWNED BY "${r}"`).catch(() => undefined);
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS "${r}"`);
  }
  await owner.$disconnect();
});

describe('etg_app: rows yes, structure no', () => {
  it('logs in with the password whose SCRAM verifier was stored', async () => {
    const [{ who, sup }] = await app.$queryRaw<{ who: string; sup: boolean }[]>`
      SELECT current_user AS who, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS sup`;
    expect(who).toBe(APP);
    expect(sup).toBe(false);
  });

  it('reads and writes rows through Prisma models, including a table added after the grants', async () => {
    await expect(app.user.count()).resolves.toEqual(expect.any(Number));
    await app.$executeRawUnsafe(`INSERT INTO "${PROBE}" (note) VALUES ('x')`);
    await app.$executeRawUnsafe(`UPDATE "${PROBE}" SET note = 'y'`);
    await app.$executeRawUnsafe(`DELETE FROM "${PROBE}"`);
  });

  it('takes advisory locks and reads connection statistics (ops dashboard)', async () => {
    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('lp-test'))`;
    });
    const rows = await app.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND state IS NOT NULL`;
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });

  it.each([
    ['CREATE TABLE', `CREATE TABLE "x_${suffix}" (id int)`],
    ['DROP TABLE', `DROP TABLE "${PROBE}"`],
    ['ALTER TABLE', `ALTER TABLE "${PROBE}" ADD COLUMN y int`],
    ['TRUNCATE', `TRUNCATE "${PROBE}"`],
    ['CREATE ROLE', `CREATE ROLE "z_${suffix}"`],
    ['CREATE DATABASE', `CREATE DATABASE "z_${suffix}"`],
    ['write migration history', `DELETE FROM "_prisma_migrations" WHERE false`],
    ['read server files', `SELECT pg_read_file('postgresql.conf')`],
  ])('refuses %s', async (_label, sql) => {
    await fails(app.$executeRawUnsafe(sql), DENIED);
  });
});

describe('etg_readonly: read only', () => {
  it('reads', async () => {
    await expect(ro.user.count()).resolves.toEqual(expect.any(Number));
  });

  it.each([
    ['INSERT', `INSERT INTO "${PROBE}" (note) VALUES ('x')`],
    ['DELETE', `DELETE FROM "${PROBE}"`],
    ['CREATE TABLE', `CREATE TABLE "y_${suffix}" (id int)`],
  ])('refuses %s', async (_label, sql) => {
    await fails(ro.$executeRawUnsafe(sql), DENIED);
  });
});

describe('secrets never leave as plaintext', () => {
  it('statements carry a verifier, not the password, and the printable form hides the verifier', () => {
    const v = scramVerifier(appPw);
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    const sts = leastPrivilegeStatements({ owner: 'o', database: 'd', appPasswordVerifier: v });
    expect(sts.join('\n')).not.toContain(appPw);
    expect(sts.map(printable).join('\n')).not.toContain(v);
  });

  it('refuses a short password and an unsafe role name', () => {
    expect(() => scramVerifier('short')).toThrow(/24 characters/);
    expect(() => leastPrivilegeStatements({ owner: 'o"; DROP', database: 'd' })).toThrow(/unsafe/);
  });
});
