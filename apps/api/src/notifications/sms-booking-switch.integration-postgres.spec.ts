import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { MarketingConsentService } from './marketing-consent.service';
import { MarketingConsentController } from './marketing-consent.controller';
import { PhoneOtpService } from '../auth/phone-otp.service';
import { SMS_TRANSACTIONAL_SCOPE } from './policy/sms-consent';

/**
 * integration-real-postgres - the "SMS about my bookings" switch in Account Settings.
 *
 * What the database must hold for the switch to be honest: ON only while consent exists for the
 * account's CURRENT verified number; switching on records a grant bound to that number, with the
 * SMS policy version and the settings source; switching off records a withdrawal; and changing
 * the number (which always takes a code) records a withdrawal too, so moving A -> B -> A never
 * revives the old agreement.
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

const CODE = '424242';
const suffix = `smsswitch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const tail = String(Date.now()).slice(-4);
const FIRST = `+1469588${tail}`;
const SECOND = `+1469589${tail}`;

describe('integration-real-postgres: SMS about my bookings switch', () => {
  const url = loadDatabaseUrl();
  let db: PrismaClient | undefined;
  let available = false;
  let consent: MarketingConsentService;
  let controller: MarketingConsentController;
  let otp: PhoneOtpService;
  let userId = '';
  const email = `switch+${suffix}@example.test`;
  const user = () => ({ id: userId, email, roles: [] }) as never;

  const smsState = async () => {
    const res = (await controller.get(user())) as {
      channels: { channel: string; granted: boolean }[];
    };
    return res.channels.find((c) => c.channel === SMS_TRANSACTIONAL_SCOPE)?.granted;
  };
  const toggle = async (granted: boolean) => {
    await new Promise((r) => setTimeout(r, 10));
    await controller.update(user(), { channel: 'sms:transactional', granted }, '127.0.0.1', 'jest');
  };
  const moveTo = async (phone: string) => {
    await new Promise((r) => setTimeout(r, 10));
    await db!.phoneOtp.create({
      data: {
        phone,
        codeHash: await bcrypt.hash(CODE, 4),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await otp.attachToAccount(userId, phone, CODE);
  };

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    consent = new MarketingConsentService(db as never);
    controller = new MarketingConsentController(consent);
    const config = { get: (_k: string, fallback?: unknown) => fallback } as never;
    otp = new PhoneOtpService(db as never, { deliver: jest.fn() } as never, config);
    const u = await db.user.create({
      data: {
        email,
        passwordHash: 'x',
        fullName: 'Switch',
        roles: ['CUSTOMER'],
        phone: FIRST,
        phoneVerifiedAt: new Date(),
      },
    });
    userId = u.id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.marketingConsent.deleteMany({ where: { email } });
    await db.phoneOtp.deleteMany({ where: { phone: { in: [FIRST, SECOND] } } });
    await db.user.deleteMany({ where: { email } });
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

  maybe('starts OFF, even with a historical grant that names no number', async () => {
    await db!.marketingConsent.create({
      data: {
        userId,
        email,
        channel: SMS_TRANSACTIONAL_SCOPE,
        granted: true,
        source: 'CUSTOMER_SIGNUP',
        phone: null,
      },
    });
    expect(await smsState()).toBe(false);
  });

  maybe(
    'switching on records a grant for the verified number, with the SMS policy, and reads ON',
    async () => {
      await toggle(true);
      const row = await db!.marketingConsent.findFirst({
        where: { userId, channel: SMS_TRANSACTIONAL_SCOPE },
        orderBy: { createdAt: 'desc' },
      });
      expect(row).toMatchObject({
        granted: true,
        phone: FIRST,
        source: 'account-settings:sms:transactional',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      });
      expect(row?.policyVersion).toMatch(/^SMS\//);
      expect(await smsState()).toBe(true);
      // A refresh reads the same answer: the state comes from the rows, not the session.
      expect(await smsState()).toBe(true);
    },
  );

  maybe(
    'switching off records a withdrawal and reads OFF; marketing SMS stays separate',
    async () => {
      await toggle(false);
      expect(await smsState()).toBe(false);
      await expect(consent.mayReceiveMarketing({ userId, email }, 'sms')).resolves.toBe(false);
      await toggle(true);
      expect(await smsState()).toBe(true);
      await expect(consent.mayReceiveMarketing({ userId, email }, 'sms')).resolves.toBe(false);
    },
  );

  maybe('a new, verified number reads OFF; moving back never revives the old grant', async () => {
    await moveTo(SECOND);
    expect(await smsState()).toBe(false);
    const changed = await db!.marketingConsent.findFirst({
      where: { userId, channel: SMS_TRANSACTIONAL_SCOPE },
      orderBy: { createdAt: 'desc' },
    });
    expect(changed).toMatchObject({ granted: false, source: 'phone-number-changed', phone: null });

    await toggle(true);
    expect(await smsState()).toBe(true);
    await expect(consent.smsTransactionalConsent({ userId, email }, SECOND)).resolves.toBe(
      'granted',
    );

    // Back to the first number: the old grant for it must not come back to life.
    await moveTo(FIRST);
    expect(await smsState()).toBe(false);
    await expect(consent.smsTransactionalConsent({ userId, email }, FIRST)).resolves.toBe(
      'withdrawn',
    );
  });

  maybe('without a verified number the switch cannot be turned on', async () => {
    await db!.user.update({ where: { id: userId }, data: { phoneVerifiedAt: null } });
    await expect(toggle(true)).rejects.toThrow(/Verify your mobile number first/);
    await db!.user.update({ where: { id: userId }, data: { phoneVerifiedAt: new Date() } });
  });
});
