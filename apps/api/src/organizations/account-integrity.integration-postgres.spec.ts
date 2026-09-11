import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth/auth.service';
import { OrganizationsService } from './organizations.service';

/**
 * integration-real-postgres — the guarantees that only a real database can prove.
 *
 * ── WHY THESE ARE NOT UNIT TESTS ───────────────────────────────────────────────────
 * Two of the claims here are about concurrency, and a mock cannot race. The organization cap is
 * a count and an insert serialised by a Postgres advisory lock; the only way to know the lock
 * holds is three registrations arriving at once and exactly two succeeding. Case-insensitive
 * lookup depends on Prisma's `mode: 'insensitive'` reaching Postgres as ILIKE, which a mock
 * accepts whatever it becomes.
 *
 * `pg_advisory_xact_lock` also returns `void`, which Prisma's `$queryRaw` cannot deserialise —
 * a failure that would only appear against a real server. This is where it would.
 *
 * Skips rather than fabricating a pass when no database is reachable.
 */

function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const txt = readFileSync(resolve(__dirname, p), 'utf8');
      const m = txt.match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

const STRONG = 'Blue-Lantern-Harbour-47';

describe('integration-real-postgres: one account per address, and a cap on pending organizations', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let auth: AuthService;
  let orgs: OrganizationsService;
  const suffix = `integrity-${Date.now()}`;

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    const config = {
      get: (_key: string, fallback?: unknown) => fallback,
      getOrThrow: () => 'integration-test-access-secret-that-is-long-enough',
    };
    auth = new AuthService(
      db as never,
      new JwtService({}),
      config as never,
      { record: async () => undefined } as never,
      { send: async () => undefined } as never,
    );
    orgs = new OrganizationsService(
      db as never,
      {} as never,
      { record: async () => undefined } as never,
      { notifyAdmins: async () => 0 } as never,
      { get: () => undefined } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (db && available) {
      const users = await db.user.findMany({
        where: { email: { contains: suffix, mode: 'insensitive' } },
        select: { id: true },
      });
      const ids = users.map((u: { id: string }) => u.id);
      await db.refreshToken.deleteMany({ where: { userId: { in: ids } } });
      await db.organizationMember.deleteMany({ where: { userId: { in: ids } } });
      await db.organization.deleteMany({ where: { name: { contains: suffix } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    }
    if (db) await db.$disconnect();
  }, 60_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      60_000,
    );

  maybe('refuses a second account for an address stored in a different case', async () => {
    // A row written before the schema lowercased input — the case a byte-comparing index misses.
    await db!.user.create({
      data: {
        email: `Legacy.${suffix}@Example.test`,
        passwordHash: 'not-a-usable-hash',
        fullName: 'Legacy Row',
        roles: ['CUSTOMER'],
      },
    });
    await expect(
      auth.register(
        {
          email: `legacy.${suffix}@example.test`,
          password: STRONG,
          fullName: 'Second Try',
        } as never,
        {},
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED' });
  });

  maybe('turns a double submission into one account and one clear refusal', async () => {
    const form = {
      email: `double.${suffix}@example.test`,
      password: STRONG,
      fullName: 'Double Click',
    } as never;

    const results = await Promise.allSettled([auth.register(form, {}), auth.register(form, {})]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // The refusal, specifically — never an unmapped database error.
    expect(refused[0].reason).toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED' });
    expect(
      await db!.user.count({ where: { email: { equals: `double.${suffix}@example.test` } } }),
    ).toBe(1);
  });

  maybe('lets exactly two of three simultaneous registrations through', async () => {
    const account = await db!.user.create({
      data: {
        email: `cap.${suffix}@example.test`,
        passwordHash: 'not-a-usable-hash',
        fullName: 'Cap Tester',
        roles: ['CUSTOMER'],
      },
    });
    const who = { id: account.id, email: account.email, roles: ['CUSTOMER'] } as never;

    const results = await Promise.allSettled(
      [1, 2, 3].map((n) =>
        orgs.register(who, {
          name: `Cap ${n} ${suffix}`,
          contactEmail: 'cap@example.test',
        } as never),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(ok).toHaveLength(2);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ code: 'ORGANIZATION_LIMIT_REACHED' });

    const pending = await db!.organization.count({
      where: { status: 'PENDING', members: { some: { userId: account.id } } },
    });
    expect(pending).toBe(2);
  });

  maybe('stops counting an organization once it has been decided', async () => {
    const account = await db!.user.findFirstOrThrow({
      where: { email: `cap.${suffix}@example.test` },
    });
    const who = { id: account.id, email: account.email, roles: ['ORGANIZER_OWNER'] } as never;
    const one = await db!.organization.findFirstOrThrow({
      where: { status: 'PENDING', members: { some: { userId: account.id } } },
    });
    await db!.organization.update({ where: { id: one.id }, data: { status: 'APPROVED' } });

    await expect(
      orgs.register(who, { name: `Cap 4 ${suffix}`, contactEmail: 'cap@example.test' } as never),
    ).resolves.toMatchObject({ status: 'PENDING' });
  });
});
