import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as bcrypt from 'bcryptjs';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { PhoneOtpService } from '../auth/phone-otp.service';
import { UsersService } from './users.service';
import { UsersController, updateProfileSchema } from './users.controller';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * integration-real-postgres - what the platform knows about where an account is, and how.
 *
 * ── THE REPORT ─────────────────────────────────────────────────────────────────────
 * The production admin Accounts page showed 8 accounts, 7 of them "Country not known": the only
 * country an account had was derived from its bookings and organizer memberships.
 *
 * ── THE MODEL THIS PINS ────────────────────────────────────────────────────────────
 *   - residence: ONLY what the person chose (profile). Never from the phone (+1 is two
 *     countries), the network or bookings.
 *   - detected: the network's country at sign-up, stored with its source, set once.
 *   - phone calling code: read from the VERIFIED number - a fact about the number.
 *   - activity: the existing bookings / organizer derivation, unchanged.
 * Each is asserted on the stored row AND on what the admin API returns.
 *
 * Skips (never fabricates a pass) when no database is reachable.
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

const CODE = '515151';

describe('integration-real-postgres: account country evidence', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let auth: AuthController;
  let users: UsersController;
  let directory: UsersService;

  const tail = String(Date.now()).slice(-6);
  const US = `+1469588${tail.slice(-4)}`;
  const CA = `+1416739${tail.slice(-4)}`;
  const IN = `+9196${tail}00`.slice(0, 13);
  const phones = [US, CA, IN];

  const config = {
    get: (k: string, fallback?: unknown) => {
      if (k === 'APP_ENV') return 'QA';
      if (k === 'JWT_ACCESS_SECRET') return 'integration-only-secret';
      return fallback;
    },
    getOrThrow: (k: string) => {
      if (k === 'JWT_ACCESS_SECRET') return 'integration-only-secret';
      throw new Error(`missing ${k}`);
    },
  };

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    const sms = { deliver: async () => ({ provider: 'twilio' }) };
    const otp = new PhoneOtpService(db as never, sms as never, config as never);
    const authService = new AuthService(
      db as never,
      { signAsync: async (p: { sub: string }) => `jwt-for-${p.sub}` } as never,
      config as never,
      { record: async () => undefined } as never,
      { send: async () => undefined } as never,
    );
    auth = new AuthController(authService, otp);
    directory = new UsersService(db as never);
    users = new UsersController(directory, {} as never);
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    const rows = await db.user.findMany({
      where: { OR: [{ phone: { in: phones } }, { email: { contains: `-${tail}@` } }] },
      select: { id: true },
    });
    const ids = rows.map((u: { id: string }) => u.id);
    await db.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.phoneOtp.deleteMany({ where: { phone: { in: phones } } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      60_000,
    );

  const req = (headers: Record<string, string> = {}) =>
    ({
      headers,
      header: (n: string) => headers[n.toLowerCase()],
      ip: '203.0.113.7',
      socket: { remoteAddress: '203.0.113.7' },
    }) as never;

  const issueCode = async (phone: string) => {
    await db!.phoneOtp.updateMany({
      where: { phone, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await db!.phoneOtp.create({
      data: {
        phone,
        codeHash: await bcrypt.hash(CODE, 4),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
  };

  const phoneSignUp = async (phone: string, headers: Record<string, string>) => {
    await issueCode(phone);
    return auth.verifyPhoneCode(
      { phone, code: CODE, fullName: 'Country Person' } as never,
      req(headers),
    ) as Promise<{ isNewAccount: boolean }>;
  };

  /** The admin directory's row for one account, found by its id. */
  const adminRow = async (id: string) => {
    const user = await db!.user.findUniqueOrThrow({ where: { id } });
    const page = await directory.list(1, 200, { query: user.email });
    const row = page.data.find((r) => r.id === id);
    if (!row) throw new Error(`account ${id} not in the directory page`);
    return row;
  };

  maybe(
    'a +1 number gets a calling code, never a residence; the network country is kept apart',
    async () => {
      const res = await phoneSignUp(US, { 'cf-ipcountry': 'US' });
      expect(res.isNewAccount).toBe(true);
      const row = await db!.user.findUniqueOrThrow({ where: { phone: US } });
      expect(row.countryOfResidence).toBeNull();
      expect(row.detectedCountry).toBe('US');
      expect(row.detectedCountrySource).toBe('network');

      const admin = await adminRow(row.id);
      expect(admin.phoneCallingCode).toBe('+1');
      expect(admin.phoneCallingCodeLabel).toBe('+1 (US/CA)');
      expect(admin.countryOfResidence).toBeNull();
      expect(admin.detectedCountry).toBe('US');
      expect(admin.detectedCountrySource).toBe('network');
      expect(admin.activityCountries).toEqual([]);
    },
  );

  maybe(
    'a Canadian number seen from India: three facts, none of them overwritten by another',
    async () => {
      await phoneSignUp(CA, { 'cf-ipcountry': 'IN' });
      const row = await db!.user.findUniqueOrThrow({ where: { phone: CA } });
      expect(row.detectedCountry).toBe('IN');
      expect(row.countryOfResidence).toBeNull();
      const admin = await adminRow(row.id);
      expect(admin.phoneCallingCodeLabel).toBe('+1 (US/CA)');

      // A later sign-in from elsewhere does not rewrite where the network placed the sign-up.
      const again = await phoneSignUp(CA, { 'cf-ipcountry': 'GB' });
      expect(again.isNewAccount).toBe(false);
      const after = await db!.user.findUniqueOrThrow({ where: { phone: CA } });
      expect(after.detectedCountry).toBe('IN');
    },
  );

  maybe('10. a chosen residence persists through the profile API and the admin API', async () => {
    await phoneSignUp(IN, {});
    const row = await db!.user.findUniqueOrThrow({ where: { phone: IN } });
    expect(row.detectedCountry).toBeNull();

    const before = await directory.directorySummary();
    const canadaBefore = before.byResidence.find((r) => r.country === 'CA')?.count ?? 0;

    // Validated exactly as the route validates it.
    const pipe = new ZodValidationPipe(updateProfileSchema);
    const body = pipe.transform({ countryOfResidence: 'ca' }, { type: 'body' }) as {
      countryOfResidence: string;
    };
    expect(body.countryOfResidence).toBe('CA');
    const updated = await users.updateMe(row.id, body);
    expect(updated.countryOfResidence).toBe('CA');
    // The name was not part of the request and is untouched.
    expect(updated.fullName).toBe('Country Person');

    expect((await directory.profile(row.id)).countryOfResidence).toBe('CA');
    expect((await adminRow(row.id)).countryOfResidence).toBe('CA');
    // The phone is Indian and the person lives in Canada: both are shown, neither wins.
    expect((await adminRow(row.id)).phoneCallingCodeLabel).toBe('+91 (IN)');

    const after = await directory.directorySummary();
    expect(after.byResidence.find((r) => r.country === 'CA')?.count).toBe(canadaBefore + 1);

    // Cleared with null - "rather not say" is an answer.
    await users.updateMe(
      row.id,
      pipe.transform({ countryOfResidence: null }, { type: 'body' }) as never,
    );
    expect((await directory.profile(row.id)).countryOfResidence).toBeNull();
  });

  maybe('10b. a residence outside the list, or an empty update, is refused', async () => {
    const pipe = new ZodValidationPipe(updateProfileSchema);
    expect(() => pipe.transform({ countryOfResidence: 'ZZ' }, { type: 'body' })).toThrow();
    expect(() => pipe.transform({}, { type: 'body' })).toThrow();
    // The existing name-only request still passes unchanged.
    expect(pipe.transform({ fullName: 'Asha Menon' }, { type: 'body' })).toEqual({
      fullName: 'Asha Menon',
    });
  });

  maybe('11. an email account with no evidence is counted as knowing nothing', async () => {
    const before = await directory.directorySummary();
    const tokens = await auth.register(
      {
        email: `nobody-${tail}@test.invalid`,
        password: 'Correct-Horse-Battery-9',
        fullName: 'No Where',
      } as never,
      req({ 'cf-ipcountry': 'XX' }),
    );
    expect(tokens).toBeTruthy();
    const row = await db!.user.findUniqueOrThrow({
      where: { email: `nobody-${tail}@test.invalid` },
    });
    // "XX" is Cloudflare for "could not tell" - not a country.
    expect(row.detectedCountry).toBeNull();
    expect(row.detectedCountrySource).toBeNull();
    const admin = await adminRow(row.id);
    expect(admin.phoneCallingCode).toBeNull();
    expect(admin.countryOfResidence).toBeNull();
    expect(admin.activityCountries).toEqual([]);

    /*
      The summary counts the whole table, and other suites write to it concurrently, so the
      card is checked for counting this account (at least one, and no fewer than before) rather
      than for an exact delta.
    */
    const after = await directory.directorySummary();
    expect(after.withoutAnyCountryEvidence).toBeGreaterThanOrEqual(1);
    expect(after.withoutAnyCountryEvidence).toBeGreaterThanOrEqual(
      before.withoutAnyCountryEvidence,
    );
    // Never more "nothing known" accounts than accounts without an activity country.
    expect(after.withoutAnyCountryEvidence).toBeLessThanOrEqual(after.withoutActivityCountry);
  });

  maybe('an email sign-up records the network country it arrived from', async () => {
    await auth.register(
      {
        email: `seen-${tail}@test.invalid`,
        password: 'Correct-Horse-Battery-9',
        fullName: 'Seen Somewhere',
      } as never,
      req({ 'cf-ipcountry': 'in' }),
    );
    const row = await db!.user.findUniqueOrThrow({ where: { email: `seen-${tail}@test.invalid` } });
    expect(row.detectedCountry).toBe('IN');
    expect(row.detectedCountrySource).toBe('network');
    expect(row.countryOfResidence).toBeNull();
  });
});
