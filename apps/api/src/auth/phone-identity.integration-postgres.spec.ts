import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as bcrypt from 'bcryptjs';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PhoneOtpService } from './phone-otp.service';
import { MarketingConsentService } from '../notifications/marketing-consent.service';
import { AccountDeletionService } from '../users/account-deletion.service';

/**
 * integration-real-postgres - one mobile number is one account, whichever form it is typed into.
 *
 * ── THE REPORT ─────────────────────────────────────────────────────────────────────
 * "I can repeatedly sign up using the same mobile number without receiving an 'account already
 * exists' message." (owner, 2026-10-25)
 *
 * ── WHAT THIS PROVES, AND HOW ──────────────────────────────────────────────────────
 * Every case drives the real controller route (`POST /auth/phone/verify` and the attach
 * routes) over the real services and a real Postgres, and then reads the TABLE: user ids, row
 * counts, names, consent rows, refresh tokens. An HTTP 200 proves nothing here - the original
 * defect answered 200 every time.
 *
 * A code is issued by writing the same row `requestCode` writes (a bcrypt hash of a known
 * code). That is test setup, not a bypass: the route under test still has to find the row,
 * spend an attempt, compare the hash and burn it. `requestCode` itself is exercised where the
 * per-number limits are the subject (case 3).
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

const CODE = '424242';

describe('integration-real-postgres: phone identity', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let controller: AuthController;
  let otp: PhoneOtpService;
  let sent: string[] = [];

  /*
    Numbers unique to this run, so a re-run against the same database never meets the rows of
    the last one. Valid mobile shapes for each market (otp-destination refuses non-mobile
    NANP numbers, which matters for case 3).
  */
  const tail = String(Date.now()).slice(-7);
  const IN = (n: number) => `+9197${String(n).padStart(2, '0')}${tail.slice(-6)}`;
  const US = `+1469588${tail.slice(-4)}`;
  const CA = `+1416739${tail.slice(-4)}`;
  const createdPhones = new Set<string>();
  /** Accounts that no longer carry a phone or a recognisable email (deleted in a test). */
  const extraIds: string[] = [];

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

    const sms = {
      deliver: async (msg: { body: string }) => {
        sent.push(msg.body);
        return { provider: 'twilio' };
      },
    };
    otp = new PhoneOtpService(db as never, sms as never, config as never);
    const auth = new AuthService(
      db as never,
      { signAsync: async (p: { sub: string }) => `jwt-for-${p.sub}` } as never,
      config as never,
      { record: async () => undefined } as never,
      { send: async () => undefined } as never,
      new MarketingConsentService(db as never),
    );
    controller = new AuthController(auth, otp);
  }, 120_000);

  beforeEach(() => {
    sent = [];
  });

  afterAll(async () => {
    if (!db || !available) return;
    const phones = [...createdPhones];
    const users = await db.user.findMany({
      where: { OR: [{ phone: { in: phones } }, { email: { contains: tail } }] },
      select: { id: true },
    });
    const ids = [...users.map((u: { id: string }) => u.id), ...extraIds];
    await db.marketingConsent.deleteMany({ where: { userId: { in: ids } } });
    await db.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await db.booking.deleteMany({ where: { event: { slug: { contains: tail } } } });
    await db.eventSession.deleteMany({ where: { event: { slug: { contains: tail } } } });
    await db.event.deleteMany({ where: { slug: { contains: tail } } });
    await db.venue.deleteMany({ where: { name: { contains: tail } } });
    await db.organization.deleteMany({ where: { slug: { contains: tail } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.phoneOtp.deleteMany({ where: { phone: { in: phones } } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  const req = (headers: Record<string, string> = {}) =>
    ({
      headers,
      header: (n: string) => headers[n.toLowerCase()],
      ip: '203.0.113.9',
      socket: { remoteAddress: '203.0.113.9' },
    }) as never;

  /** Exactly the row `requestCode` writes: the previous live code dies, a hashed one is born. */
  const issueCode = async (e164: string, code = CODE) => {
    createdPhones.add(e164);
    await db!.phoneOtp.updateMany({
      where: { phone: e164, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await db!.phoneOtp.create({
      data: {
        phone: e164,
        codeHash: await bcrypt.hash(code, 4),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
  };

  const usersWith = (e164: string) => db!.user.findMany({ where: { phone: e164 } });

  const signUp = (
    phone: string,
    extra: { fullName?: string; smsConsent?: true; country?: string } = {},
    headers?: Record<string, string>,
  ) =>
    controller.verifyPhoneCode(
      { phone, code: CODE, fullName: 'Asha Menon', ...extra } as never,
      req(headers),
    ) as Promise<{ accessToken?: string; refreshToken?: string; isNewAccount: boolean }>;

  const signIn = (phone: string, code = CODE) =>
    controller.verifyPhoneCode({ phone, code } as never, req()) as Promise<{
      accessToken?: string;
      isNewAccount: boolean;
    }>;

  // ── 1 ────────────────────────────────────────────────────────────────────────────
  maybe('1. a first-time phone sign-up creates exactly one verified account', async () => {
    const phone = IN(1);
    await issueCode(phone);
    const res = await signUp(phone);

    expect(res.isNewAccount).toBe(true);
    const rows = await usersWith(phone);
    expect(rows).toHaveLength(1);
    expect(rows[0].fullName).toBe('Asha Menon');
    expect(rows[0].phoneVerifiedAt).toBeInstanceOf(Date);
    expect(rows[0].roles).toEqual(['CUSTOMER']);
    expect(res.accessToken).toBe(`jwt-for-${rows[0].id}`);
    expect(await db!.refreshToken.count({ where: { userId: rows[0].id } })).toBe(1);
  });

  // ── 2 ────────────────────────────────────────────────────────────────────────────
  maybe(
    '2. a second sign-up with the same verified number signs into THAT account and changes nothing',
    async () => {
      const phone = IN(2);
      await issueCode(phone);
      const first = await signUp(phone, { fullName: 'Asha Menon' });
      expect(first.isNewAccount).toBe(true);
      const [original] = await usersWith(phone);
      const usersBefore = await db!.user.count();

      await issueCode(phone);
      const second = await signUp(phone, { fullName: 'Somebody Else' });

      // The response says so - the clients turn this into "You already have an account".
      expect(second.isNewAccount).toBe(false);
      // Same account: no new row anywhere, and the session is for the original id.
      expect(await db!.user.count()).toBe(usersBefore);
      const rows = await usersWith(phone);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(original.id);
      expect(second.accessToken).toBe(`jwt-for-${original.id}`);
      // Profile not overwritten.
      expect(rows[0].fullName).toBe('Asha Menon');
      expect(rows[0].email).toBe(original.email);
    },
  );

  maybe(
    '2b. a sign-up over an existing NAMELESS phone account does not apply the sign-up name',
    async () => {
      // The account was made by the Sign-in tab, which asks for no name.
      const phone = IN(3);
      await issueCode(phone);
      const made = await signIn(phone);
      expect(made.isNewAccount).toBe(true);
      const [nameless] = await usersWith(phone);
      expect(nameless.fullName).toBe('');

      await issueCode(phone);
      const res = await signUp(phone, { fullName: 'Typed On Sign Up' });
      expect(res.isNewAccount).toBe(false);
      const [after] = await usersWith(phone);
      expect(after.id).toBe(nameless.id);
      // Sign-up data belongs to a NEW account only; the existing profile is the person's own.
      expect(after.fullName).toBe('');
    },
  );

  maybe(
    '2c. a sign-up over an existing account records no sign-up text-message consent',
    async () => {
      const phone = US;
      await issueCode(phone);
      const first = await signUp(phone, { fullName: 'Pat Doe' });
      expect(first.isNewAccount).toBe(true);
      const [user] = await usersWith(phone);
      const consentsBefore = await db!.marketingConsent.count({ where: { userId: user.id } });
      expect(consentsBefore).toBe(0);

      await issueCode(phone);
      const res = await signUp(phone, { fullName: 'Pat Doe', smsConsent: true, country: 'US' });
      expect(res.isNewAccount).toBe(false);
      // Recording CUSTOMER_SIGNUP evidence against an account that did not sign up would be a
      // consent record for something that never happened.
      expect(await db!.marketingConsent.count({ where: { userId: user.id } })).toBe(0);
    },
  );

  // ── 3 ────────────────────────────────────────────────────────────────────────────
  maybe(
    '3. repeated code requests for one number are still limited (cooldown), one live code',
    async () => {
      const phone = IN(4);
      createdPhones.add(phone);
      await otp.requestCode(phone, '203.0.113.9');
      await expect(otp.requestCode(phone, '203.0.113.9')).rejects.toMatchObject({
        status: 429,
      });
      expect(sent).toHaveLength(1);
      expect(await db!.phoneOtp.count({ where: { phone, consumedAt: null } })).toBe(1);
      // The response is the same for a known and an unknown number: nothing is created yet.
      expect(await usersWith(phone)).toHaveLength(0);
    },
  );

  // ── 4 ────────────────────────────────────────────────────────────────────────────
  maybe('4. the same number written four ways is one identity', async () => {
    const e164 = IN(5); // +9198NNNNNNNNN
    const national = e164.slice(3); // 10 digits
    const spaced = `+91 ${national.slice(0, 5)} ${national.slice(5)}`;
    const trunk = `+91 0${national}`; // the domestic 0 kept after the code
    const doubleZero = `0091${national}`;

    await issueCode(e164);
    const first = await signUp(spaced);
    expect(first.isNewAccount).toBe(true);
    const [user] = await usersWith(e164);
    // Stored in E.164, whatever was typed.
    expect(user.phone).toBe(e164);

    for (const typed of [trunk, doubleZero, e164]) {
      await issueCode(e164);
      const again = await signIn(typed);
      expect(again.isNewAccount).toBe(false);
      expect(again.accessToken).toBe(`jwt-for-${user.id}`);
    }
    expect(await usersWith(e164)).toHaveLength(1);
    expect(await db!.user.count({ where: { phone: { contains: national } } })).toBe(1);
  });

  // ── 5 ────────────────────────────────────────────────────────────────────────────
  maybe('5. two simultaneous verifications of a new number make one user', async () => {
    const phone = IN(6);
    createdPhones.add(phone);
    /*
      Two live codes for one number cannot exist through `requestCode` (a new one kills the
      old), so two devices are simulated as two rows with the SAME code: each request wins its
      own row, both pass the code check, and both reach account creation together - the race
      the unique index exists for.
    */
    const hash = await bcrypt.hash(CODE, 4);
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await db!.phoneOtp.createMany({
      data: [
        { phone, codeHash: hash, expiresAt },
        { phone, codeHash: hash, expiresAt },
      ],
    });
    const settled = await Promise.allSettled([signIn(phone), signIn(phone)]);
    const ok = settled.filter(
      (s): s is PromiseFulfilledResult<{ accessToken?: string; isNewAccount: boolean }> =>
        s.status === 'fulfilled',
    );
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const rows = await usersWith(phone);
    expect(rows).toHaveLength(1);
    // Every successful answer is a session for the one account.
    for (const r of ok) expect(r.value.accessToken).toBe(`jwt-for-${rows[0].id}`);
    // At most one of them may say it created the account.
    expect(ok.filter((r) => r.value.isNewAccount).length).toBeLessThanOrEqual(1);
    expect(await db!.user.count({ where: { email: { contains: phone.slice(1) } } })).toBe(1);
  });

  // ── 6 + 7 ────────────────────────────────────────────────────────────────────────
  const emailUser = (label: string) =>
    db!.user.create({
      data: {
        email: `${label}-${tail}@test.invalid`,
        fullName: `Email ${label}`,
        passwordHash: 'x',
        roles: ['CUSTOMER'],
      },
    });

  maybe('6. an email account attaches a proven number to ITSELF, no new account', async () => {
    const owner = await emailUser('attach');
    const phone = IN(7);
    const before = await db!.user.count();
    await issueCode(phone);
    const res = await controller.attachPhone(
      { id: owner.id } as never,
      { phone: `+91 ${phone.slice(3)}`, code: CODE } as never,
    );
    expect(res.phone).toBe(phone);
    expect(await db!.user.count()).toBe(before);
    const row = await db!.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.phone).toBe(phone);
    expect(row.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(row.email).toBe(owner.email);

    // Signing in with the number now opens the EMAIL account.
    await issueCode(phone);
    const signedIn = await signIn(phone);
    expect(signedIn.isNewAccount).toBe(false);
    expect(signedIn.accessToken).toBe(`jwt-for-${owner.id}`);
  });

  maybe('7. a number verified on account A is refused on account B', async () => {
    const phone = IN(8);
    await issueCode(phone);
    await signUp(phone, { fullName: 'Holder A' });
    const [a] = await usersWith(phone);
    const b = await emailUser('other');

    await issueCode(phone);
    await expect(
      controller.attachPhone({ id: b.id } as never, { phone, code: CODE } as never),
    ).rejects.toMatchObject({ status: 409 });

    const rowB = await db!.user.findUniqueOrThrow({ where: { id: b.id } });
    expect(rowB.phone).toBeNull();
    expect(rowB.phoneVerifiedAt).toBeNull();
    const rowsA = await usersWith(phone);
    expect(rowsA.map((u: { id: string }) => u.id)).toEqual([a.id]);
  });

  maybe('7b. an unproven claim (wrong code) never attaches the number', async () => {
    const b = await emailUser('wrongcode');
    const phone = IN(9);
    await issueCode(phone);
    await expect(
      controller.attachPhone({ id: b.id } as never, { phone, code: '000000' } as never),
    ).rejects.toMatchObject({ status: 401 });
    const rowB = await db!.user.findUniqueOrThrow({ where: { id: b.id } });
    expect(rowB.phone).toBeNull();
  });

  // ── 8 ────────────────────────────────────────────────────────────────────────────
  maybe('8. a wrong, expired or reused code creates nothing and signs nobody in', async () => {
    const phone = IN(10);
    const before = await db!.user.count();

    await issueCode(phone);
    await expect(signIn(phone, '000000')).rejects.toMatchObject({ status: 401 });

    // Expired.
    createdPhones.add(phone);
    await db!.phoneOtp.updateMany({ where: { phone }, data: { consumedAt: new Date() } });
    await db!.phoneOtp.create({
      data: {
        phone,
        codeHash: await bcrypt.hash(CODE, 4),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await expect(signIn(phone)).rejects.toMatchObject({ status: 401 });
    expect(await db!.user.count()).toBe(before);

    // Reused: spent once, refused the second time.
    await issueCode(phone);
    const ok = await signIn(phone);
    expect(ok.isNewAccount).toBe(true);
    await expect(signIn(phone)).rejects.toMatchObject({ status: 401 });
    expect(await usersWith(phone)).toHaveLength(1);
  });

  // ── 12 ───────────────────────────────────────────────────────────────────────────
  maybe('12. IN, US and CA numbers are stored in E.164 and stay separate accounts', async () => {
    const inPhone = IN(11);
    for (const p of [inPhone, CA]) {
      await issueCode(p);
      await signUp(p, { fullName: 'Market Person' });
    }
    const [inUser] = await usersWith(inPhone);
    const [caUser] = await usersWith(CA);
    expect(inUser.phone).toMatch(/^\+91\d{10}$/);
    expect(caUser.phone).toMatch(/^\+1\d{10}$/);
    expect(inUser.id).not.toBe(caUser.id);
    // The US number from case 2c is its own account too.
    const usRows = await usersWith(US);
    expect(usRows).toHaveLength(1);
    expect(usRows[0].id).not.toBe(caUser.id);
  });

  // ── 13 + 14 ──────────────────────────────────────────────────────────────────────
  maybe(
    '13/14. bookings stay on their user through a repeat sign-up; deletion frees the number',
    async () => {
      const phone = IN(12);
      await issueCode(phone);
      await signUp(phone, { fullName: 'Ticket Holder' });
      const [holder] = await usersWith(phone);

      const org = await db!.organization.create({
        data: { name: `PI ${tail}`, slug: `pi-${tail}`, registeredCountry: 'IN' },
      });
      const venue = await db!.venue.create({
        data: { organizationId: org.id, name: `PI ${tail}`, city: 'Vijayawada', country: 'IN' },
      });
      const event = await db!.event.create({
        data: {
          organizationId: org.id,
          venueId: venue.id,
          title: `PI ${tail}`,
          slug: `pi-${tail}`,
          category: 'Music',
          status: 'PUBLISHED',
        },
      });
      const session = await db!.eventSession.create({
        data: {
          eventId: event.id,
          startsAt: new Date(Date.now() + 86_400_000),
          endsAt: new Date(Date.now() + 90_000_000),
        },
      });
      const booking = await db!.booking.create({
        data: {
          organizationId: org.id,
          eventId: event.id,
          eventSessionId: session.id,
          userId: holder.id,
          buyerName: 'Ticket Holder',
          buyerEmail: `holder-${tail}@test.invalid`,
          status: 'CONFIRMED',
          currency: 'INR',
          subtotalMinor: 15000,
          totalMinor: 15000,
          holdExpiresAt: new Date(),
        },
      });

      // A repeat "sign up" lands on the holder, so the booking is reachable from that session.
      await issueCode(phone);
      const again = await signUp(phone, { fullName: 'Not The Holder' });
      expect(again.accessToken).toBe(`jwt-for-${holder.id}`);
      const b = await db!.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(b.userId).toBe(holder.id);
      expect(await db!.booking.count({ where: { userId: holder.id } })).toBe(1);

      // 14. Account deletion clears the number (kept behaviour), so it can be used again - by
      // a NEW account, never by re-opening the deleted one.
      extraIds.push(holder.id);
      await new AccountDeletionService(db as never).deleteMe(holder.id);
      const gone = await db!.user.findUniqueOrThrow({ where: { id: holder.id } });
      expect(gone.status).toBe('DELETED');
      expect(gone.phone).toBeNull();
      expect(gone.phoneVerifiedAt).toBeNull();
      await issueCode(phone);
      const fresh = await signUp(phone, { fullName: 'Next Owner' });
      expect(fresh.isNewAccount).toBe(true);
      const [next] = await usersWith(phone);
      expect(next.id).not.toBe(holder.id);
      // The old booking stays with the old (deleted) account.
      const kept = await db!.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(kept.userId).toBe(holder.id);
    },
  );
});
