import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * integration-real-postgres - the READ-ONLY phone identity audit (`scripts/audit-phone-identity.sql`).
 *
 * The script is meant to be run on production before anybody trusts "one verified number = one
 * account" there. Two promises are checked:
 *   - it CANNOT write: the file holds nothing but SELECT/WITH between `BEGIN TRANSACTION READ
 *     ONLY` and `ROLLBACK`, and each statement is run here inside a read-only transaction;
 *   - it FINDS what it says: a seeded duplicate (the same number stored two ways), a phone with
 *     no proof, and a stranded phone-only placeholder each appear in their section.
 */
const file = readFileSync(resolve(__dirname, '../../scripts/audit-phone-identity.sql'), 'utf8');
const withoutComments = file
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');
const statements = withoutComments
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean);

describe('the phone identity audit is read-only by construction', () => {
  it('opens a READ ONLY transaction and ends in ROLLBACK', () => {
    expect(statements[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(statements[statements.length - 1].replace(/;$/, '')).toBe('ROLLBACK');
  });

  it('contains nothing but SELECT / WITH in between', () => {
    for (const st of statements.slice(1, -1)) expect(st).toMatch(/^(SELECT|WITH)\b/);
    expect(withoutComments).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO)\b/i,
    );
  });

  it('prints no email address and never a full number', () => {
    expect(withoutComments).not.toMatch(/SELECT[^;]*u\."email"\s+AS/i);
    expect(withoutComments).toMatch(/right\(d\.d1, 4\)/);
  });
});

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

const url = databaseUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip('integration-real-postgres: the phone identity audit finds what it reports', () => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const tag = `audit${process.pid}${Date.now().toString(36)}`;
  // Not real numbers: an Indian range, unique per run.
  const digits = `9199${String(Date.now()).slice(-8)}`;
  const ids = { a: `${tag}-a`, b: `${tag}-b`, c: `${tag}-c` };

  beforeAll(async () => {
    await db.user.createMany({
      data: [
        // The same number stored canonically and with a kept trunk zero: one person, two rows.
        {
          id: ids.a,
          email: `phone+${digits}@users.eticketsgo.internal`,
          phone: `+${digits}`,
          passwordHash: 'x',
          fullName: '',
        },
        {
          id: ids.b,
          email: `${tag}-b@test.invalid`,
          phone: `+91 0${digits.slice(2)}`,
          passwordHash: 'x',
          fullName: 'B',
        },
        // A phone-only placeholder whose number was cleared by hand.
        {
          id: ids.c,
          email: `phone+1555${digits.slice(-7)}@users.eticketsgo.internal`,
          phone: null,
          passwordHash: 'x',
          fullName: '',
        },
      ],
    });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await db.$disconnect();
  });

  it('reports the duplicate, the unverified numbers and the stranded placeholder', async () => {
    const results = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const out: Record<string, unknown>[][] = [];
      for (const st of statements.slice(1, -1)) out.push(await tx.$queryRawUnsafe(st));
      // Proof the transaction really is read-only: a write is refused by the server.
      await expect(
        tx.$executeRawUnsafe(`UPDATE "User" SET "fullName" = 'x' WHERE "id" = '${ids.a}'`),
      ).rejects.toThrow(/read-only/i);
      return out;
    });

    // Results alternate: a heading row, then that section's rows.
    const section = (title: string) => {
      const i = results.findIndex((r) =>
        (r[0] as { section?: string })?.section?.startsWith(title),
      );
      expect(i).toBeGreaterThanOrEqual(0);
      return results[i + 1] as { user_id?: string; group_no?: unknown }[];
    };
    const users = (rows: { user_id?: string }[]) => rows.map((r) => r.user_id);

    const dupes = section('1.').filter((r) => r.user_id === ids.a || r.user_id === ids.b);
    expect(dupes).toHaveLength(2);
    expect(String(dupes[0].group_no)).toBe(String(dupes[1].group_no));
    expect(users(section('2.'))).toContain(ids.b);
    expect(users(section('2.'))).not.toContain(ids.a);
    expect(users(section('4a.'))).toEqual(expect.arrayContaining([ids.a, ids.b]));
    expect(users(section('5.'))).toContain(ids.c);

    // Masked: no row carries the full number.
    const printed = JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    expect(printed).not.toContain(digits);
    expect(printed).not.toContain(digits.slice(2));
  });
});
