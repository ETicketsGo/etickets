import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Role, SuppressionReason } from '@eticketsgo/shared-types';
import type { RequestUser } from '../common/decorators';
import { AuditService } from '../audit/audit.service';
import {
  MARKETING_UNSUBSCRIBE_LIFTED,
  MarketingConsentService,
} from '../notifications/marketing-consent.service';
import { SuppressionService } from '../notifications/delivery/suppression.service';
import { NotificationOpsService } from '../notifications/delivery/notification-ops.service';
import { CampaignDispatchService } from '../campaigns/campaign-dispatch.service';
import { classifiedAudienceSql } from '../campaigns/campaign-audience';
import { CommunicationConsentService } from './communication-consent.service';
import { OrganizerFollowService } from './organizer-follow.service';
import { UnsubscribeService } from './unsubscribe.service';
import { signUnsubscribeToken, unsubscribeKey } from './unsubscribe-token';

/**
 * integration-real-postgres - who wins between an opt-in, an unsubscribe, a complaint and a
 * hard bounce (owner decisions 2026-10-28).
 *
 *   1. An organizer unsubscribe is reversed only by an opt-in for THAT organizer.
 *   2. A global marketing unsubscribe stands until the person turns marketing email back on
 *      in their ACCOUNT-WIDE settings.
 *   3. Allowing one organizer never removes a global unsubscribe: the consent is recorded, and
 *      takes effect only once global marketing is back on.
 *   4. A COMPLAINT (global MARKETING row or organizer row) is never lifted by the person.
 *   5. A HARD_BOUNCE is lifted only by staff, audited.
 *   6. Lifting sets liftedAt/liftedBy, never deletes; consent rows only ever grow.
 *
 * Each case checks the campaign audience SQL and the send-time check, not just a flag.
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
  // Every environment needs a footer address (no placeholder). Fictional, address-shaped.
  MARKETING_POSTAL_ADDRESS_IN: '1 Test Road, Test Nagar, Vijayawada 520001, India',
  MARKETING_POSTAL_ADDRESS_US: '100 Test Street, Suite 1, Springfield, IL 62701, USA',
};
const config = { get: (k: string) => CONFIG[k] } as never;

describe('integration-real-postgres: unsubscribe, complaint and bounce precedence', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;

  const tag = `prec-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const hashes: string[] = [];

  let suppression: SuppressionService;
  let marketing: MarketingConsentService;
  let consent: CommunicationConsentService;
  let follows: OrganizerFollowService;
  let unsubscribe: UnsubscribeService;
  let ops: NotificationOpsService;
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
    hashes.push(SuppressionService.hash('email', u.email));
    return { id: u.id, email: u.email, fullName: u.fullName, roles: roles as Role[] };
  }

  async function makeOrg(label: string) {
    const org = await db!.organization.create({
      data: { name: `${label} ${tag}`, slug: `${label}-${tag}`, status: 'APPROVED' },
    });
    orgIds.push(org.id);
    return org.id;
  }

  /** A follower of both organizers. */
  async function follower(label: string, orgs: string[]) {
    const u = await makeUser(label);
    for (const org of orgs) await follows.follow(u, org, 'ORGANIZER_PAGE');
    return u;
  }

  const hashOf = (u: RequestUser) => SuppressionService.hash('email', u.email);

  // ── The person's actions ───────────────────────────────────────────────────────

  /** The "unsubscribe from all marketing email" link. */
  async function unsubscribeAll(u: RequestUser) {
    const token = signUnsubscribeToken(
      {
        userId: u.id,
        email: u.email,
        scope: 'global',
        organizationId: null,
        purpose: 'MARKETING_EMAIL',
      },
      unsubscribeKey(config),
    );
    await unsubscribe.unsubscribe(token, { oneClick: true });
  }

  /** The "unsubscribe from this organizer" link. */
  async function unsubscribeFrom(u: RequestUser, organizationId: string) {
    const token = signUnsubscribeToken(
      { userId: u.id, email: u.email, scope: 'organizer', organizationId, purpose: 'ALL' },
      unsubscribeKey(config),
    );
    await unsubscribe.unsubscribe(token, { oneClick: true });
  }

  /** The follow dialog: "Email me about new events" for one organizer. */
  async function allowOrganizer(u: RequestUser, organizationId: string) {
    await follows.setPreferences(u, organizationId, { emailUpdates: true }, ctx);
  }

  /**
   * The account notification settings toggle (PUT me/marketing-consent, channel email), as
   * the controller calls it.
   */
  async function marketingOnAccountWide(u: RequestUser) {
    await marketing.record({ userId: u.id, email: u.email }, 'email', true, {
      source: 'account-settings:email',
      accountWide: true,
    });
  }

  // ── What a campaign would do ───────────────────────────────────────────────────

  /** The campaign audience classification for this person (FOLLOWERS, ORGANIZER_UPDATES). */
  async function audienceRow(u: RequestUser, organizationId: string) {
    const rows: {
      granted: boolean;
      org_suppressed: boolean;
      global_suppressed: boolean;
    }[] = await db!.$queryRaw(
      Prisma.sql`${classifiedAudienceSql(organizationId, 'ORGANIZER_UPDATES', {
        sources: ['FOLLOWERS'],
      })}
      SELECT granted, org_suppressed, global_suppressed FROM classified WHERE h = ${hashOf(u)}`,
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    return { ...r, eligible: r.granted && !r.org_suppressed && !r.global_suppressed };
  }

  /** The send-time check the dispatcher runs before every message (fails closed). */
  async function sendCheck(u: RequestUser, organizationId: string) {
    const blockedNow = (
      CampaignDispatchService.prototype as unknown as {
        blockedNow: (
          c: { organizationId: string; purpose: string },
          r: { userId: string | null; emailHash: string },
        ) => Promise<string | null>;
      }
    ).blockedNow;
    return blockedNow.call(
      { prisma: db },
      { organizationId, purpose: 'ORGANIZER_UPDATES' },
      { userId: u.id, emailHash: hashOf(u) },
    );
  }

  const globalRow = (u: RequestUser, scope: 'ALL' | 'MARKETING') =>
    db!.suppressedDestination.findUnique({
      where: {
        channel_destinationHash_scope: { channel: 'email', destinationHash: hashOf(u), scope },
      },
    });
  const orgRow = (u: RequestUser, organizationId: string) =>
    db!.organizerSuppression.findUnique({
      where: {
        organizationId_channel_destinationHash: {
          organizationId,
          channel: 'email',
          destinationHash: hashOf(u),
        },
      },
    });

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      await db!.$queryRaw`SELECT 1 FROM "OrganizerSuppression" LIMIT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable or not migrated');
      return;
    }
    const audit = new AuditService(db as never);
    suppression = new SuppressionService(db as never);
    marketing = new MarketingConsentService(db as never, suppression, audit);
    consent = new CommunicationConsentService(db as never, audit, marketing, suppression);
    follows = new OrganizerFollowService(db as never, consent);
    unsubscribe = new UnsubscribeService(db as never, config, consent, undefined, suppression);
    ops = new NotificationOpsService(db as never, audit, suppression);
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    const orgFilter = { organizationId: { in: orgIds } };
    await db.communicationConsent.deleteMany({ where: orgFilter });
    await db.organizerSuppression.deleteMany({ where: orgFilter });
    await db.suppressedDestination.deleteMany({ where: { destinationHash: { in: hashes } } });
    await db.organizerNotificationPreference.deleteMany({ where: orgFilter });
    await db.organizerFollow.deleteMany({ where: orgFilter });
    await db.auditLog.deleteMany({ where: { entityId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
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

  maybe(
    'global unsubscribe + organizer opt-in: consent recorded, global row NOT lifted, still excluded; account-wide re-enable then lifts it, audited',
    async () => {
      const orgA = await makeOrg('g-a');
      const u = await follower('global', [orgA]);
      await unsubscribeAll(u);
      expect(await globalRow(u, 'MARKETING')).toMatchObject({
        reason: SuppressionReason.UNSUBSCRIBED,
        liftedAt: null,
      });

      await allowOrganizer(u, orgA);

      // The organizer consent row is written...
      const granted = await db!.communicationConsent.findMany({
        where: { userId: u.id, organizationId: orgA, purpose: 'ORGANIZER_UPDATES', granted: true },
      });
      expect(granted).toHaveLength(1);
      // ...but the global unsubscribe stands, and the person is excluded everywhere.
      expect(await globalRow(u, 'MARKETING')).toMatchObject({ liftedAt: null, liftedBy: null });
      expect(await audienceRow(u, orgA)).toMatchObject({
        granted: true,
        global_suppressed: true,
        eligible: false,
      });
      expect(await sendCheck(u, orgA)).toBe('SKIPPED_SUPPRESSED');
      expect(await consent.mayEmailForOrganizer(u, orgA, 'ORGANIZER_UPDATES')).toBe(false);
      // The follow screens are told why.
      expect((await follows.preferences(u, orgA)).globalMarketingUnsubscribed).toBe(true);

      // A platform marketing grant that is NOT from the account-wide setting lifts nothing.
      await marketing.record({ userId: u.id, email: u.email }, 'email', true, {
        source: 'checkout:marketing-email',
      });
      expect(await globalRow(u, 'MARKETING')).toMatchObject({ liftedAt: null });
      expect(await sendCheck(u, orgA)).toBe('SKIPPED_SUPPRESSED');

      // The account-wide setting is the way back.
      await marketingOnAccountWide(u);
      const lifted = await globalRow(u, 'MARKETING');
      expect(lifted).not.toBeNull(); // lifted, not deleted
      expect(lifted!.liftedAt).toBeInstanceOf(Date);
      expect(lifted!.liftedBy).toBe('account:global-opt-in');
      const audit = await db!.auditLog.findMany({
        where: { entityId: u.id, action: MARKETING_UNSUBSCRIBE_LIFTED },
      });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0])).not.toContain(u.email);

      // The organizer consent given earlier now takes effect.
      expect(await audienceRow(u, orgA)).toMatchObject({ eligible: true });
      expect(await sendCheck(u, orgA)).toBeNull();
      expect(await consent.mayEmailForOrganizer(u, orgA, 'ORGANIZER_UPDATES')).toBe(true);
      expect((await follows.preferences(u, orgA)).globalMarketingUnsubscribed).toBe(false);

      // The consent history is append-only: withdrawn, then granted, both still there.
      const marketingRows = await db!.marketingConsent.findMany({
        where: { userId: u.id, channel: 'email' },
        orderBy: { createdAt: 'asc' },
      });
      expect(marketingRows.map((r: { granted: boolean }) => r.granted)).toEqual([
        false,
        true,
        true,
      ]);
    },
  );

  maybe(
    'the me/communication-consent marketing-email path is account-wide too and lifts the same row',
    async () => {
      const orgA = await makeOrg('cc-a');
      const u = await follower('ccpath', [orgA]);
      await unsubscribeAll(u);
      await consent.record(
        { userId: u.id, email: u.email },
        { purpose: 'MARKETING_EMAIL', organizationId: null, granted: true },
        { source: 'account-settings:marketing-email', actorUserId: u.id, accountWide: true },
      );
      expect((await globalRow(u, 'MARKETING'))!.liftedBy).toBe('account:global-opt-in');
    },
  );

  maybe(
    'organizer unsubscribe: an opt-in for that organizer lifts only that organizer row; the other stays',
    async () => {
      const orgA = await makeOrg('o-a');
      const orgB = await makeOrg('o-b');
      const u = await follower('orgunsub', [orgA, orgB]);
      await allowOrganizer(u, orgA);
      await allowOrganizer(u, orgB);
      await unsubscribeFrom(u, orgA);
      await unsubscribeFrom(u, orgB);
      expect(await sendCheck(u, orgA)).toBe('SKIPPED_CONSENT');
      expect(await sendCheck(u, orgB)).toBe('SKIPPED_CONSENT');

      await allowOrganizer(u, orgA);

      const a = await orgRow(u, orgA);
      expect(a).not.toBeNull();
      expect(a!.reason).toBe(SuppressionReason.UNSUBSCRIBED);
      expect(a!.liftedAt).toBeInstanceOf(Date);
      expect(await orgRow(u, orgB)).toMatchObject({ liftedAt: null });
      expect(await audienceRow(u, orgA)).toMatchObject({ eligible: true });
      expect(await sendCheck(u, orgA)).toBeNull();
      expect(await audienceRow(u, orgB)).toMatchObject({ granted: false, eligible: false });
      expect(await sendCheck(u, orgB)).toBe('SKIPPED_CONSENT');
      // The global list was never touched by any of it.
      expect(await globalRow(u, 'MARKETING')).toBeNull();
      expect(await globalRow(u, 'ALL')).toBeNull();
    },
  );

  maybe(
    'complaint (global MARKETING + organizer): neither an organizer opt-in nor the account-wide setting lifts it',
    async () => {
      const orgA = await makeOrg('c-a');
      const u = await follower('complainer', [orgA]);
      // What a campaign complaint writes: a MARKETING-scope COMPLAINT, and the organizer's own.
      await suppression.suppress({
        channel: 'email',
        destination: u.email,
        reason: SuppressionReason.COMPLAINT,
        provider: 'ses',
      });
      await db!.organizerSuppression.create({
        data: {
          organizationId: orgA,
          channel: 'email',
          destinationHash: hashOf(u),
          reason: SuppressionReason.COMPLAINT,
        },
      });
      // A later click on an organizer unsubscribe link must not downgrade the complaint.
      await unsubscribeFrom(u, orgA);
      expect(await orgRow(u, orgA)).toMatchObject({
        reason: SuppressionReason.COMPLAINT,
        liftedAt: null,
      });

      await allowOrganizer(u, orgA);
      await marketingOnAccountWide(u);

      expect(await globalRow(u, 'MARKETING')).toMatchObject({
        reason: SuppressionReason.COMPLAINT,
        liftedAt: null,
        liftedBy: null,
      });
      expect(await orgRow(u, orgA)).toMatchObject({
        reason: SuppressionReason.COMPLAINT,
        liftedAt: null,
      });
      expect(await audienceRow(u, orgA)).toMatchObject({
        granted: true,
        org_suppressed: true,
        global_suppressed: true,
        eligible: false,
      });
      expect(await sendCheck(u, orgA)).toBe('SKIPPED_SUPPRESSED');
      expect(await consent.mayEmailForOrganizer(u, orgA, 'ORGANIZER_UPDATES')).toBe(false);
      // Tickets still go: a complaint is MARKETING-only.
      expect(await suppression.isSuppressed('email', u.email)).toBe(false);
    },
  );

  maybe(
    'hard bounce (ALL): no customer action lifts it; everything is blocked; only the audited staff lift does',
    async () => {
      const orgA = await makeOrg('b-a');
      const u = await follower('bounced', [orgA]);
      const staff = await makeUser('staff', ['SUPER_ADMIN']);
      await suppression.suppress({
        channel: 'email',
        destination: u.email,
        reason: SuppressionReason.HARD_BOUNCE,
        provider: 'ses',
      });
      await allowOrganizer(u, orgA);
      await marketingOnAccountWide(u);
      await consent.record(
        { userId: u.id, email: u.email },
        { purpose: 'MARKETING_EMAIL', organizationId: null, granted: true },
        { source: 'account-settings:marketing-email', actorUserId: u.id, accountWide: true },
      );

      const row = await globalRow(u, 'ALL');
      expect(row).toMatchObject({ reason: SuppressionReason.HARD_BOUNCE, liftedAt: null });
      expect(await suppression.isSuppressed('email', u.email)).toBe(true); // transactional
      expect(await suppression.isSuppressed('email', u.email, 'marketing')).toBe(true);
      expect(await audienceRow(u, orgA)).toMatchObject({
        global_suppressed: true,
        eligible: false,
      });
      expect(await sendCheck(u, orgA)).toBe('SKIPPED_SUPPRESSED');

      // The staff path: lifted (not deleted), by whom, and audited.
      expect(await ops.liftSuppression(staff.id, row!.id)).toEqual({ lifted: true });
      const after = await globalRow(u, 'ALL');
      expect(after).not.toBeNull();
      expect(after!.liftedAt).toBeInstanceOf(Date);
      expect(after!.liftedBy).toBe(staff.id);
      expect(
        await db!.auditLog.count({
          where: { actorUserId: staff.id, action: 'SUPPRESSION_LIFTED', entityId: row!.id },
        }),
      ).toBe(1);
      expect(await suppression.isSuppressed('email', u.email)).toBe(false);
      expect(await sendCheck(u, orgA)).toBeNull();
      await db!.auditLog.deleteMany({ where: { entityId: row!.id } });
    },
  );

  maybe('audit history: lifts keep every row, and consent rows only ever grow', async () => {
    const orgA = await makeOrg('h-a');
    const u = await follower('history', [orgA]);
    const count = async () => ({
      consent: await db!.communicationConsent.count({ where: { userId: u.id } }),
      marketing: await db!.marketingConsent.count({ where: { userId: u.id } }),
      suppressed: await db!.suppressedDestination.count({
        where: { destinationHash: hashOf(u) },
      }),
      org: await db!.organizerSuppression.count({ where: { destinationHash: hashOf(u) } }),
    });
    const seen: Awaited<ReturnType<typeof count>>[] = [await count()];
    for (const step of [
      () => allowOrganizer(u, orgA),
      () => unsubscribeFrom(u, orgA),
      () => allowOrganizer(u, orgA),
      () => unsubscribeAll(u),
      () => marketingOnAccountWide(u),
      () => unsubscribeAll(u),
    ]) {
      await step();
      seen.push(await count());
    }
    for (let i = 1; i < seen.length; i += 1) {
      for (const k of ['consent', 'marketing', 'suppressed', 'org'] as const) {
        expect(seen[i][k]).toBeGreaterThanOrEqual(seen[i - 1][k]);
      }
    }
    // One row per destination and scope: re-armed after the lift, never a second row, and
    // never deleted.
    expect(seen[seen.length - 1].suppressed).toBe(1);
    expect(await globalRow(u, 'MARKETING')).toMatchObject({
      reason: SuppressionReason.UNSUBSCRIBED,
      liftedAt: null,
    });
    expect(seen[seen.length - 1].org).toBe(1);
  });
});
