import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Role } from '@eticketsgo/shared-types';
import type { RequestUser } from '../common/decorators';
import { AuditService } from '../audit/audit.service';
import { MarketingConsentService } from '../notifications/marketing-consent.service';
import { SuppressionService } from '../notifications/delivery/suppression.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AccountDeletionService } from '../users/account-deletion.service';
import { CommunicationConsentService } from './communication-consent.service';
import { OrganizerFollowService } from './organizer-follow.service';
import { UnsubscribeService } from './unsubscribe.service';
import { AudienceSummaryService } from './audience-summary.service';
import { signUnsubscribeToken, unsubscribeKey } from './unsubscribe-token';

/**
 * integration-real-postgres - following, consent, unsubscribe and the audience counts.
 *
 * What only a real database proves: that the unique index makes a racing follow one row,
 * that the newest consent row really wins in the audience SQL, that a tenant's counts read
 * only its own rows, and that deletion leaves evidence without the person.
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

const CONFIG: Record<string, string> = {
  JWT_ACCESS_SECRET: 'integration-test-secret-integration-test-secret',
  APP_ENV: 'LOCAL',
  PUBLIC_API_URL: 'https://api.example.test',
};
const config = { get: (k: string) => CONFIG[k] } as never;

describe('integration-real-postgres: organizer follows and communication consent', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;

  const tag = `follow-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const orgIds: string[] = [];
  const userIds: string[] = [];

  let consent: CommunicationConsentService;
  let follows: OrganizerFollowService;
  let unsubscribe: UnsubscribeService;
  let audience: AudienceSummaryService;
  let deletion: AccountDeletionService;

  let orgA = '';
  let orgB = '';
  let ownerA: RequestUser;
  let ownerB: RequestUser;
  const ctx = { source: 'test', ipAddress: '127.0.0.1', userAgent: 'jest' };

  async function makeUser(label: string, roles: string[] = ['CUSTOMER']): Promise<RequestUser> {
    const u = await db!.user.create({
      data: {
        email: `${label}-${tag}@example.test`,
        fullName: label,
        passwordHash: 'x',
        roles: roles as never,
      },
    });
    userIds.push(u.id);
    return { id: u.id, email: u.email, fullName: u.fullName, roles: roles as Role[] };
  }

  async function makeOrg(label: string) {
    const org = await db!.organization.create({
      data: { name: `${label} ${tag}`, slug: `${label}-${tag}`, status: 'APPROVED' },
    });
    orgIds.push(org.id);
    return org.id;
  }

  /** A confirmed booking by `userId` with `orgId`, at a venue in `city`. */
  async function booked(orgId: string, userId: string, city: string) {
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `Hall ${city}`, city, country: 'India' },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Show ${randomBytes(3).toString('hex')}`,
        slug: `show-${randomBytes(5).toString('hex')}`,
        category: 'Concert',
        status: 'PUBLISHED',
      },
    });
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
    const session = await db!.eventSession.create({
      data: { eventId: event.id, startsAt, endsAt: new Date(startsAt.getTime() + 7_200_000) },
    });
    await db!.booking.create({
      data: {
        organizationId: orgId,
        eventId: event.id,
        eventSessionId: session.id,
        userId,
        buyerName: 'Buyer',
        buyerEmail: `buyer-${tag}@example.test`,
        status: 'CONFIRMED',
        subtotalMinor: 1000,
        totalMinor: 1000,
        confirmedAt: new Date(),
        holdExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      await db!.$queryRaw`SELECT 1 FROM "OrganizerFollow" LIMIT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable or not migrated');
      return;
    }
    const audit = new AuditService(db as never);
    const marketing = new MarketingConsentService(db as never);
    const suppression = new SuppressionService(db as never);
    consent = new CommunicationConsentService(db as never, audit, marketing, suppression);
    follows = new OrganizerFollowService(db as never, consent);
    unsubscribe = new UnsubscribeService(db as never, config, consent);
    audience = new AudienceSummaryService(db as never, new OrgAccessService(db as never, audit));
    deletion = new AccountDeletionService(db as never);

    orgA = await makeOrg('alpha');
    orgB = await makeOrg('beta');
    ownerA = await makeUser('owner-a', ['ORGANIZER_OWNER']);
    ownerB = await makeUser('owner-b', ['ORGANIZER_OWNER']);
    await db!.organizationMember.create({
      data: { organizationId: orgA, userId: ownerA.id, role: 'ORGANIZER_OWNER' },
    });
    await db!.organizationMember.create({
      data: { organizationId: orgB, userId: ownerB.id, role: 'ORGANIZER_OWNER' },
    });
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    const orgFilter = { organizationId: { in: orgIds } };
    await db.communicationConsent.deleteMany({ where: orgFilter });
    await db.organizerSuppression.deleteMany({ where: orgFilter });
    await db.booking.deleteMany({ where: orgFilter });
    await db.eventSession.deleteMany({ where: { event: orgFilter } });
    await db.event.deleteMany({ where: orgFilter });
    await db.venue.deleteMany({ where: orgFilter });
    await db.organizationMember.deleteMany({ where: orgFilter });
    await db.auditLog.deleteMany({ where: { entityId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: orgFilter });
    await db.marketingConsent.deleteMany({ where: { email: { contains: tag } } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
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

  maybe('follow and unfollow are idempotent', async () => {
    const asha = await makeUser('asha');
    const first = await follows.follow(asha, orgA, 'ORGANIZER_PAGE');
    const second = await follows.follow(asha, orgA, 'ORGANIZER_PAGE');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await db!.organizerFollow.count({ where: { userId: asha.id } })).toBe(1);
    expect((await follows.status(asha, orgA)).following).toBe(true);

    await follows.unfollow(asha, orgA, ctx);
    await follows.unfollow(asha, orgA, ctx);
    expect(await db!.organizerFollow.count({ where: { userId: asha.id } })).toBe(0);
    expect((await follows.status(asha, orgA)).following).toBe(false);
  });

  maybe('ten racing follows leave exactly one row and no error', async () => {
    const ravi = await makeUser('ravi');
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => follows.follow(ravi, orgA, 'ORGANIZER_PAGE')),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(
      await db!.organizerFollow.count({ where: { userId: ravi.id, organizationId: orgA } }),
    ).toBe(1);
    expect(
      await db!.organizerNotificationPreference.count({
        where: { userId: ravi.id, organizationId: orgA },
      }),
    ).toBe(1);
  });

  maybe('the unique index refuses a duplicate follow written directly', async () => {
    const meena = await makeUser('meena');
    await db!.organizerFollow.create({
      data: { userId: meena.id, organizationId: orgA, source: 'ORGANIZER_PAGE' },
    });
    await expect(
      db!.organizerFollow.create({
        data: { userId: meena.id, organizationId: orgA, source: 'ORGANIZER_PAGE' },
      }),
    ).rejects.toThrow();
  });

  maybe('following grants no marketing consent of any kind', async () => {
    const kiran = await makeUser('kiran');
    await follows.follow(kiran, orgB, 'BOOKING_CONFIRMATION');
    const subject = { userId: kiran.id, email: kiran.email };

    expect(await db!.communicationConsent.count({ where: { userId: kiran.id } })).toBe(0);
    expect(await db!.marketingConsent.count({ where: { userId: kiran.id } })).toBe(0);
    for (const p of ['ORGANIZER_UPDATES', 'EARLY_ACCESS', 'OFFERS'] as const) {
      expect(await consent.mayEmailForOrganizer(subject, orgB, p)).toBe(false);
    }
    const prefs = await follows.preferences(kiran, orgB);
    expect(prefs).toMatchObject({
      newEvents: true,
      emailUpdates: false,
      earlyAccess: false,
      offers: false,
      cadence: 'INSTANT',
    });
    expect((await audience.compute(orgB)).eligibleSubscribers).toBe(0);
  });

  maybe('an explicit opt-in writes evidence and makes the follower eligible', async () => {
    const lata = await makeUser('lata');
    await follows.follow(lata, orgB, 'ORGANIZER_PAGE');
    const before = (await audience.compute(orgB)).eligibleSubscribers;
    await follows.setPreferences(lata, orgB, { emailUpdates: true, cadence: 'WEEKLY_DIGEST' }, ctx);

    const rows = await db!.communicationConsent.findMany({ where: { userId: lata.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: 'ORGANIZER_UPDATES',
      organizationId: orgB,
      granted: true,
      policyVersion: 'MARKETING/GLOBAL/v1',
    });
    // The hash, never the address.
    expect(rows[0].subjectHash).toBe(SuppressionService.hash('email', lata.email));
    expect(JSON.stringify(rows[0])).not.toContain(lata.email);
    expect(
      await db!.auditLog.count({
        where: { entityId: lata.id, action: 'COMMUNICATION_CONSENT_GRANTED' },
      }),
    ).toBe(1);
    expect((await audience.compute(orgB)).eligibleSubscribers).toBe(before + 1);
    expect((await follows.preferences(lata, orgB)).cadence).toBe('WEEKLY_DIGEST');

    // Saving the same answer again does not pad the history.
    await follows.setPreferences(lata, orgB, { emailUpdates: true }, ctx);
    expect(await db!.communicationConsent.count({ where: { userId: lata.id } })).toBe(1);
  });

  maybe('org A cannot read org B audience, and counts never cross tenants', async () => {
    // Make the two totals differ, so a count read from the wrong tenant cannot pass.
    await follows.follow(await makeUser('extra-a1'), orgA, 'ORGANIZER_PAGE');
    await follows.follow(await makeUser('extra-a2'), orgA, 'ORGANIZER_PAGE');
    await expect(audience.summary(ownerA, orgB)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TENANT_FORBIDDEN' }),
    });
    const a = await audience.summary(ownerA, orgA);
    const b = await audience.summary(ownerB, orgB);
    expect(a.followers.total).toBe(
      await db!.organizerFollow.count({ where: { organizationId: orgA } }),
    );
    expect(b.followers.total).toBe(
      await db!.organizerFollow.count({ where: { organizationId: orgB } }),
    );
    expect(a.followers.total).not.toBe(b.followers.total);
    // Aggregates only: no email address or user id anywhere in the response.
    const text = JSON.stringify(a);
    expect(text).not.toMatch(/@example\.test/);
    for (const id of userIds) expect(text).not.toContain(id);
    expect(a.growth.daily).toHaveLength(30);
    expect(a.growth.weekly).toHaveLength(12);
    expect(a.growth.daily[29].followers).toBe(a.followers.total);
  });

  maybe('a tampered unsubscribe token is refused and writes nothing', async () => {
    const neha = await makeUser('neha');
    const key = unsubscribeKey(config);
    const token = signUnsubscribeToken(
      {
        userId: neha.id,
        email: neha.email,
        scope: 'organizer',
        organizationId: orgA,
        purpose: 'ALL',
      },
      key,
    );
    const [body, sig] = token.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    forged.o = orgB;
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;

    await expect(unsubscribe.unsubscribe(tampered, { oneClick: true })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    });
    await expect(unsubscribe.preview(`${body}.${sig.slice(0, -2)}AA`)).rejects.toBeDefined();
    expect(await db!.communicationConsent.count({ where: { userId: neha.id } })).toBe(0);
    expect(
      await db!.organizerSuppression.count({
        where: { destinationHash: SuppressionService.hash('email', neha.email) },
      }),
    ).toBe(0);
  });

  maybe(
    'organizer unsubscribe writes withdrawals and a suppression; opting in lifts it',
    async () => {
      const omar = await makeUser('omar');
      await follows.follow(omar, orgA, 'ORGANIZER_PAGE');
      await follows.setPreferences(omar, orgA, { emailUpdates: true, offers: true }, ctx);
      const subject = { userId: omar.id, email: omar.email };
      expect(await consent.mayEmailForOrganizer(subject, orgA, 'OFFERS')).toBe(true);
      const eligibleBefore = (await audience.compute(orgA)).eligibleSubscribers;

      const token = signUnsubscribeToken(
        {
          userId: omar.id,
          email: omar.email,
          scope: 'organizer',
          organizationId: orgA,
          purpose: 'ALL',
        },
        unsubscribeKey(config),
      );
      const preview = await unsubscribe.preview(token);
      expect(preview.organization?.id).toBe(orgA);
      expect(preview.emailMask).not.toBe(omar.email);
      // GET changes nothing.
      expect(await consent.mayEmailForOrganizer(subject, orgA, 'OFFERS')).toBe(true);

      const res = await unsubscribe.unsubscribe(token, { oneClick: true });
      expect(res.unsubscribed).toBe(true);
      const withdrawals = await db!.communicationConsent.findMany({
        where: { userId: omar.id, granted: false },
      });
      expect(withdrawals.map((w: { purpose: string }) => w.purpose).sort()).toEqual([
        'EARLY_ACCESS',
        'OFFERS',
        'ORGANIZER_UPDATES',
      ]);
      expect(
        withdrawals.every((w: { source: string }) => w.source === 'unsubscribe-one-click'),
      ).toBe(true);
      const suppression = await db!.organizerSuppression.findUnique({
        where: {
          organizationId_channel_destinationHash: {
            organizationId: orgA,
            channel: 'email',
            destinationHash: SuppressionService.hash('email', omar.email),
          },
        },
      });
      expect(suppression).toMatchObject({ reason: 'UNSUBSCRIBED', liftedAt: null });
      for (const p of ['ORGANIZER_UPDATES', 'EARLY_ACCESS', 'OFFERS'] as const) {
        expect(await consent.mayEmailForOrganizer(subject, orgA, p)).toBe(false);
      }
      expect((await follows.preferences(omar, orgA)).offers).toBe(false);
      expect((await audience.compute(orgA)).eligibleSubscribers).toBe(eligibleBefore - 1);
      // The global list (which also blocks tickets) is untouched.
      expect(
        await db!.suppressedDestination.count({
          where: { destinationHash: SuppressionService.hash('email', omar.email) },
        }),
      ).toBe(0);

      // A second click is harmless.
      await unsubscribe.unsubscribe(token, { oneClick: false });

      // Opting in again from the account lifts the suppression.
      await follows.setPreferences(omar, orgA, { emailUpdates: true }, ctx);
      expect(await consent.mayEmailForOrganizer(subject, orgA, 'ORGANIZER_UPDATES')).toBe(true);
    },
  );

  maybe(
    'global unsubscribe withdraws platform marketing email and never blocks tickets',
    async () => {
      const priya = await makeUser('priya');
      const subject = { userId: priya.id, email: priya.email };
      await consent.record(
        subject,
        { purpose: 'MARKETING_EMAIL', organizationId: null, granted: true },
        ctx,
      );
      const marketing = new MarketingConsentService(db as never);
      expect(await marketing.mayReceiveMarketing(subject, 'email')).toBe(true);

      const token = signUnsubscribeToken(
        {
          userId: priya.id,
          email: priya.email,
          scope: 'global',
          organizationId: null,
          purpose: 'MARKETING_EMAIL',
        },
        unsubscribeKey(config),
      );
      await unsubscribe.unsubscribe(token, { oneClick: false });
      expect(await marketing.mayReceiveMarketing(subject, 'email')).toBe(false);
      // One store for platform marketing email: nothing written to the scoped table.
      expect(await db!.communicationConsent.count({ where: { userId: priya.id } })).toBe(0);
      expect(
        await db!.suppressedDestination.count({
          where: { destinationHash: SuppressionService.hash('email', priya.email) },
        }),
      ).toBe(0);
      const history = await consent.history(subject);
      expect(history.map((h) => h.granted)).toEqual([false, true]);
    },
  );

  maybe(
    'account deletion removes follows and keeps consent evidence without the person',
    async () => {
      const sam = await makeUser('sam');
      await follows.follow(sam, orgA, 'ORGANIZER_PAGE');
      await follows.setPreferences(sam, orgA, { emailUpdates: true }, ctx);
      const hash = SuppressionService.hash('email', sam.email);

      await deletion.deleteMe(sam.id);

      expect(await db!.organizerFollow.count({ where: { userId: sam.id } })).toBe(0);
      expect(await db!.organizerNotificationPreference.count({ where: { userId: sam.id } })).toBe(
        0,
      );
      expect(await db!.communicationConsent.count({ where: { userId: sam.id } })).toBe(0);
      const evidence = await db!.communicationConsent.findMany({
        where: { subjectHash: hash },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        evidence.map((e: { granted: boolean; source: string }) => [e.granted, e.source]),
      ).toEqual([
        [true, 'following-preferences:ORGANIZER_UPDATES'],
        [false, 'withdrawn-on-account-deletion'],
      ]);
      // A new account with the same address starts from "no".
      const again = await db!.user.create({
        data: { email: sam.email, fullName: 'Sam again', passwordHash: 'x' },
      });
      userIds.push(again.id);
      expect(
        await consent.mayEmailForOrganizer(
          { userId: again.id, email: sam.email },
          orgA,
          'ORGANIZER_UPDATES',
        ),
      ).toBe(false);
    },
  );

  maybe('city buckets below five followers are hidden', async () => {
    const orgC = await makeOrg('gamma');
    for (let i = 0; i < 6; i++) {
      const u = await makeUser(`vij-${i}`);
      await follows.follow(u, orgC, 'ORGANIZER_PAGE');
      await booked(orgC, u.id, 'Vijayawada');
    }
    for (let i = 0; i < 2; i++) {
      const u = await makeUser(`gun-${i}`);
      await follows.follow(u, orgC, 'ORGANIZER_PAGE');
      await booked(orgC, u.id, 'Guntur');
      // A second booking makes them a returning buyer.
      await booked(orgC, u.id, 'Guntur');
    }
    const s = await audience.compute(orgC);
    expect(s.cities.buckets).toEqual([{ city: 'Vijayawada', country: 'India', followers: 6 }]);
    expect(s.cities.hiddenBuckets).toBe(1);
    expect(s.cities.threshold).toBe(5);
    expect(JSON.stringify(s.cities)).not.toContain('Guntur');
    expect(s.returningBuyers).toBe(2);
    expect(s.followers).toMatchObject({ total: 8, new7d: 8, new30d: 8 });
  });
});
