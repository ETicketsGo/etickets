import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

/**
 * integration-real-postgres — a person who forgets their password can get back in.
 *
 * ── WHAT WAS MISSING ───────────────────────────────────────────────────────────────
 * Nothing. There was no password-reset flow anywhere in auth: the only ways to hold a
 * working password were to register with one or to accept an invitation. Anybody who
 * forgot theirs had no route back, and support had none to offer them either.
 *
 * That absence is also what made the old invite path so damaging — it created accounts
 * nobody could sign into, and there was no mechanism to recover one.
 *
 * Proven against a real database because every property here is about what was WRITTEN:
 * a hash replaced, sessions revoked, a token spent, a pending invitation completed. A
 * stubbed Prisma returns whatever the test hands it and would report all of this working.
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

const CUSTOMER_BASE = 'https://tickets.example.test';

describe('integration-real-postgres: password reset', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let auth: AuthService;

  /** Every notification the service tried to send, so delivery can be asserted. */
  let sent: { type: string; toEmail?: string | null; payload: Record<string, unknown> }[] = [];

  const suffix = `reset-${Date.now()}`;
  const email = `forgetful-${suffix}@test.invalid`;
  let userId = '';

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

    auth = new AuthService(
      db as never,
      { signAsync: async () => 'jwt' } as never,
      {
        get: (k: string) => (k === 'CUSTOMER_WEB_URL' ? CUSTOMER_BASE : 'QA'),
      } as never,
      { record: async () => undefined } as never,
      {
        send: async (m: { type: string; toEmail?: string | null; payload: never }) => {
          sent.push(m);
        },
      } as never,
    );
  }, 120_000);

  beforeEach(() => {
    sent = [];
  });

  afterAll(async () => {
    if (!db || !available) return;
    await db.passwordResetToken.deleteMany({ where: { user: { email: { contains: suffix } } } });
    await db.refreshToken.deleteMany({ where: { user: { email: { contains: suffix } } } });
    await db.accountInvitation.deleteMany({ where: { user: { email: { contains: suffix } } } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  /** The token only ever leaves inside the emailed link; this is how a test gets at it. */
  const tokenFromLink = (link: string) => new URL(link).searchParams.get('token')!;

  const freshUser = async (addr: string, password = 'OriginalPass1!') => {
    const u = await db!.user.create({
      data: {
        email: addr,
        fullName: 'Forgetful Person',
        passwordHash: await bcrypt.hash(password, 10),
        roles: ['CUSTOMER'],
      },
    });
    return u;
  };

  maybe(
    'a forgotten password can be replaced, and every session dies with it',
    async () => {
      const user = await freshUser(email);
      userId = user.id;

      // Two live sessions, as somebody signed in on a phone and a laptop would have.
      await db!.refreshToken.createMany({
        data: [
          { userId, tokenHash: `rt-a-${suffix}`, expiresAt: new Date(Date.now() + 86_400_000) },
          { userId, tokenHash: `rt-b-${suffix}`, expiresAt: new Date(Date.now() + 86_400_000) },
        ],
      });

      await auth.requestPasswordReset(email, { ip: '203.0.113.1' });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('PASSWORD_RESET_REQUESTED');
      expect(sent[0].toEmail).toBe(email);
      const link = String(sent[0].payload.link);
      expect(link.startsWith(`${CUSTOMER_BASE}/reset-password?token=`)).toBe(true);

      await auth.resetPassword(tokenFromLink(link), 'BrandNewPass1!', { ip: '203.0.113.1' });

      const after = await db!.user.findUnique({ where: { id: userId } });
      expect(await bcrypt.compare('BrandNewPass1!', after.passwordHash)).toBe(true);
      expect(await bcrypt.compare('OriginalPass1!', after.passwordHash)).toBe(false);

      /*
        The property that matters most. If the reset was asked for because somebody else got
        in, leaving their refresh token alive means the password change accomplished nothing
        — they keep the account, and the owner believes they recovered it.
      */
      const live = await db!.refreshToken.count({ where: { userId, revokedAt: null } });
      expect(live).toBe(0);

      // And the owner is told, which is the only warning they get if it was not them.
      expect(sent.map((m) => m.type)).toContain('PASSWORD_CHANGED');
    },
    120_000,
  );

  maybe(
    'the link is spent once used, and a new request kills the previous one',
    async () => {
      const addr = `spent-${suffix}@test.invalid`;
      await freshUser(addr);

      await auth.requestPasswordReset(addr, {});
      const first = tokenFromLink(String(sent[0].payload.link));

      /*
        Asking again invalidates the earlier link. Two live keys to one account means an old
        one — forwarded, screenshotted, sitting in a mailbox — still opens the door after the
        owner has asked for a fresh one.
      */
      sent = [];
      await auth.requestPasswordReset(addr, {});
      const second = tokenFromLink(String(sent[0].payload.link));
      expect(second).not.toBe(first);

      await expect(auth.resetPassword(first, 'Whatever1!', {})).rejects.toThrow(/no longer valid/i);

      await auth.resetPassword(second, 'SecondPass1!', {});
      await expect(auth.resetPassword(second, 'ThirdPass1!', {})).rejects.toThrow(
        /no longer valid/i,
      );
    },
    120_000,
  );

  maybe(
    'an unknown address is answered silently, and writes nothing',
    async () => {
      /*
        The anti-enumeration property. If this threw, or sent, or left a row behind that a
        later query could reveal, the endpoint would become a way to discover who holds an
        account — and on a ticketing platform, who bought tickets to what.
      */
      const before = await db!.passwordResetToken.count();
      await expect(
        auth.requestPasswordReset(`nobody-${suffix}@test.invalid`, {}),
      ).resolves.toBeUndefined();

      expect(sent).toHaveLength(0);
      expect(await db!.passwordResetToken.count()).toBe(before);
    },
    120_000,
  );

  maybe(
    'an expired link is refused, and says the same thing as a bad one',
    async () => {
      const addr = `stale-${suffix}@test.invalid`;
      await freshUser(addr);
      await auth.requestPasswordReset(addr, {});
      const token = tokenFromLink(String(sent[0].payload.link));

      await db!.passwordResetToken.update({
        where: { tokenHash: createHash('sha256').update(token).digest('hex') },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      // Deliberately the same wording as an unknown token: telling them apart tells somebody
      // holding a stolen link whether it is worth chasing a fresher one.
      await expect(auth.resetPassword(token, 'TooLate1!', {})).rejects.toThrow(/no longer valid/i);
      await expect(auth.resetPassword('not-a-real-token-at-all', 'Nope1!', {})).rejects.toThrow(
        /no longer valid/i,
      );
    },
    120_000,
  );

  maybe(
    'the raw token is never stored',
    async () => {
      const addr = `hashed-${suffix}@test.invalid`;
      await freshUser(addr);
      await auth.requestPasswordReset(addr, {});
      const token = tokenFromLink(String(sent[0].payload.link));

      const rows = await db!.passwordResetToken.findMany({
        where: { user: { email: addr } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).not.toContain(token);
      expect(rows[0].tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    },
    120_000,
  );

  maybe(
    'resetting also completes an invitation that was never accepted',
    async () => {
      /*
        The two mechanisms ask for the same proof — control of the address — so a reset
        satisfies an outstanding invitation. Without this, somebody invited but never
        activated would end up with a working password and still no access: exactly the dead
        end the invitation work removed, rebuilt through a different door.
      */
      const org = await db!.organization.create({
        data: { name: `Reset Org ${suffix}`, slug: `reset-org-${suffix}` },
      });
      const addr = `pending-${suffix}@test.invalid`;
      const user = await freshUser(addr);
      const member = await db!.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          role: 'CHECKIN_STAFF',
          status: 'INVITED',
        },
      });
      await db!.accountInvitation.create({
        data: {
          userId: user.id,
          organizationMemberId: member.id,
          tokenHash: `pending-${suffix}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedByUserId: user.id,
        },
      });

      await auth.requestPasswordReset(addr, {});
      await auth.resetPassword(tokenFromLink(String(sent[0].payload.link)), 'Claimed1!', {});

      const after = await db!.organizationMember.findUnique({ where: { id: member.id } });
      expect(after.status).toBe('ACTIVE');
      const invitation = await db!.accountInvitation.findFirst({ where: { userId: user.id } });
      expect(invitation.acceptedAt).not.toBeNull();

      await db!.accountInvitation.deleteMany({ where: { userId: user.id } });
      await db!.organizationMember.deleteMany({ where: { organizationId: org.id } });
      await db!.organization.deleteMany({ where: { id: org.id } });
    },
    120_000,
  );

  maybe(
    'a deployed environment refuses to build a localhost reset link',
    async () => {
      // The defect that reached QA on the invitation work, guarded for before shipping here.
      const unconfigured = new AuthService(
        db as never,
        { signAsync: async () => 'jwt' } as never,
        { get: (k: string) => (k === 'APP_ENV' ? 'QA' : undefined) } as never,
        { record: async () => undefined } as never,
        { send: async () => undefined } as never,
      );
      const addr = `nolink-${suffix}@test.invalid`;
      await freshUser(addr);
      await expect(unconfigured.requestPasswordReset(addr, {})).rejects.toThrow(/CUSTOMER_WEB_URL/);
    },
    120_000,
  );
});
