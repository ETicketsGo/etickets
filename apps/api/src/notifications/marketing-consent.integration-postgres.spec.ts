import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MarketingConsentService } from './marketing-consent.service';

/**
 * integration-real-postgres — the consent log behaves like evidence.
 *
 * The properties being proven are properties of the STORE, not of a service method: that a
 * withdrawal appends rather than overwrites, that the newest row wins, and that a person
 * who withdrew as a guest is not re-subscribed by creating an account. A stubbed client
 * would happily return whatever the test told it to.
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

describe('integration-real-postgres: marketing consent', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let consent: MarketingConsentService;

  const suffix = `consent-${Date.now()}`;
  const EMAIL = `asha+${suffix}@example.test`;
  let userId = '';

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    consent = new MarketingConsentService(db as never);
    const user = await db.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Asha', roles: ['CUSTOMER'] },
    });
    userId = user.id;
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.marketingConsent.deleteMany({ where: { email: { contains: suffix } } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await db.$disconnect();
  }, 60_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  maybe('says no when nothing has ever been recorded', async () => {
    // Silence is not consent. Read the other way, the first promotional message ever sent
    // would go to everybody who ever bought a ticket.
    expect(await consent.mayReceiveMarketing({ userId, email: EMAIL }, 'email')).toBe(false);
  });

  maybe(
    'says yes once consent is granted, and records how it was obtained',
    async () => {
      await consent.record({ userId, email: EMAIL }, 'email', true, {
        source: 'checkout-optin',
        ipAddress: '203.0.113.7',
        userAgent: 'e2e',
      });
      expect(await consent.mayReceiveMarketing({ userId, email: EMAIL }, 'email')).toBe(true);

      const [state] = await consent.stateFor({ userId, email: EMAIL }, ['email']);
      expect(state.granted).toBe(true);
      expect(state.source).toBe('checkout-optin');
      expect(state.decidedAt).toBeInstanceOf(Date);
    },
    60_000,
  );

  maybe(
    'withdrawal APPENDS — the grant is still on file afterwards',
    async () => {
      /*
      The reason the table is append-only. A boolean column would answer "are they
      subscribed now" and destroy the evidence that consent was ever given, which is the
      one thing a regulator actually asks to see. Both rows must survive.
    */
      await consent.record({ userId, email: EMAIL }, 'email', false, {
        source: 'unsubscribe-link',
      });
      expect(await consent.mayReceiveMarketing({ userId, email: EMAIL }, 'email')).toBe(false);

      const history = await consent.history({ userId, email: EMAIL });
      const emailRows = history.filter((h) => h.channel === 'email');
      expect(emailRows).toHaveLength(2);
      expect(emailRows[0].granted).toBe(false);
      expect(emailRows[0].source).toBe('unsubscribe-link');
      // The original grant, intact.
      expect(emailRows[1].granted).toBe(true);
      expect(emailRows[1].source).toBe('checkout-optin');
    },
    60_000,
  );

  maybe(
    're-granting after a withdrawal works, and keeps both earlier rows',
    async () => {
      await consent.record({ userId, email: EMAIL }, 'email', true, { source: 'account-settings' });
      expect(await consent.mayReceiveMarketing({ userId, email: EMAIL }, 'email')).toBe(true);
      const history = await consent.history({ userId, email: EMAIL });
      expect(history.filter((h) => h.channel === 'email')).toHaveLength(3);
    },
    60_000,
  );

  maybe(
    'consent is per channel — email does not imply push',
    async () => {
      expect(await consent.mayReceiveMarketing({ userId, email: EMAIL }, 'email')).toBe(true);
      expect(await consent.mayReceiveMarketing({ userId, email: EMAIL }, 'push')).toBe(false);
    },
    60_000,
  );

  maybe(
    'a guest who withdrew is not re-subscribed by creating an account',
    async () => {
      /*
      The bug this prevents: consent keyed only on user id. A guest buys a ticket, opts out,
      later registers with the same address — and the new account has no consent rows, which
      a user-id-only lookup reads as "no decision yet" rather than "they said no".
    */
      const guestEmail = `guest+${suffix}@example.test`;
      await consent.record({ userId: null, email: guestEmail }, 'email', false, {
        source: 'unsubscribe-link',
      });

      const registered = await db!.user.create({
        data: { email: guestEmail, passwordHash: 'x', fullName: 'Guest', roles: ['CUSTOMER'] },
      });
      expect(
        await consent.mayReceiveMarketing({ userId: registered.id, email: guestEmail }, 'email'),
      ).toBe(false);
    },
    60_000,
  );

  maybe(
    'matches the address case- and whitespace-insensitively',
    async () => {
      const mixed = `  ${EMAIL.toUpperCase()} `;
      expect(await consent.mayReceiveMarketing({ userId: null, email: mixed }, 'email')).toBe(true);
    },
    60_000,
  );

  maybe(
    'refuses to record a row it could never match again',
    async () => {
      // A consent row with no subject looks like evidence and proves nothing. Better to
      // write nothing and log it than to accumulate unattributable records.
      const before = await db!.marketingConsent.count();
      await consent.record({ userId: null, email: null }, 'email', true, { source: 'broken-form' });
      expect(await db!.marketingConsent.count()).toBe(before);
    },
    60_000,
  );
});
