import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DeliveryState, Role } from '@eticketsgo/shared-types';
import type { RequestUser } from '../common/decorators';
import { AuditService } from '../audit/audit.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { EntitlementService } from '../billing/entitlements/entitlement.service';
import { MarketingConsentService } from '../notifications/marketing-consent.service';
import { SuppressionService } from '../notifications/delivery/suppression.service';
import { ProviderEventSinks } from '../notifications/delivery/provider-event-sinks';
import { DeliveryRecorderService } from '../notifications/delivery/delivery-recorder.service';
import { CommunicationConsentService } from '../engagement/communication-consent.service';
import { UnsubscribeService } from '../engagement/unsubscribe.service';
import { UnsubscribeHooks } from '../engagement/unsubscribe-hooks';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignRenderService } from './campaign-render.service';
import { CampaignDispatchService, RetryableSendError } from './campaign-dispatch.service';
import { CampaignEventsService } from './campaign-events.service';
import { CampaignAnalyticsService } from './campaign-analytics.service';
import { CampaignAdminService } from './campaign-admin.service';
import type { CampaignMessage, CampaignTransport } from './campaign-transport';

/**
 * integration-real-postgres - the campaign pipeline against a real database.
 *
 * What only a real database proves: that the audience SQL counts nobody without consent and
 * nobody suppressed, that one organizer's numbers read only its own rows, that the unique index
 * and the conditional claims make a recipient one send whatever is rerun, that a consent
 * withdrawn after the list was built is honoured at send time, that a credit is spent only
 * when the provider accepted, and that SES events, unsubscribes and clicks land where they
 * should. The provider is a recording double; nothing leaves the machine.
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
  APP_ENV: 'QA',
  CAMPAIGNS_ENABLED: 'true',
  EMAIL_PROVIDER: 'ses',
  EMAIL_FROM: 'tickets@eticketsgo.test',
  SES_CONFIGURATION_SET: 'qa-transactional',
  PUBLIC_API_URL: 'https://api.example.test',
  CUSTOMER_WEB_URL: 'https://shop.example.test',
  CAMPAIGN_SEND_RATE_PER_SECOND: '5',
};
const config = { get: (k: string) => CONFIG[k] } as never;

/** Records every message; refuses or throws for chosen addresses. */
class RecordingTransport implements CampaignTransport {
  readonly name = 'ses' as const;
  sent: CampaignMessage[] = [];
  behaviour = new Map<string, 'reject' | 'transient' | 'paused'>();
  private n = 0;
  async send(msg: CampaignMessage) {
    const b = this.behaviour.get(msg.to);
    if (b === 'reject')
      throw Object.assign(new Error('Address blacklisted'), { name: 'MessageRejected' });
    if (b === 'transient')
      throw Object.assign(new Error('Slow down'), { name: 'TooManyRequestsException' });
    if (b === 'paused')
      throw Object.assign(new Error('Paused'), { name: 'SendingPausedException' });
    this.sent.push(msg);
    this.n += 1;
    return {
      provider: 'ses',
      providerMessageId: `msg-${this.n}-${randomBytes(4).toString('hex')}`,
    };
  }
}

describe('integration-real-postgres: organizer campaigns', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  const tag = `cmp-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const started = new Date();

  let transport: RecordingTransport;
  let campaigns: CampaignsService;
  let dispatch: CampaignDispatchService;
  let events: CampaignEventsService;
  let analytics: CampaignAnalyticsService;
  let admin: CampaignAdminService;
  let consent: CommunicationConsentService;
  let unsubscribe: UnsubscribeService;
  let recorder: DeliveryRecorderService;

  let orgA = '';
  let orgB = '';
  let orgPlain = '';
  let ownerA: RequestUser;
  let ownerB: RequestUser;
  let ownerPlain: RequestUser;
  const people: Record<string, RequestUser> = {};
  let eventA = '';
  let eventB = '';
  const ctx = { source: 'test', ipAddress: '127.0.0.1', userAgent: 'jest' };

  const orgIds: string[] = [];
  const userIds: string[] = [];

  async function makeUser(label: string, roles: string[] = ['CUSTOMER'], verified = false) {
    const u = await db!.user.create({
      data: {
        email: `${label}-${tag}@example.test`,
        fullName: label,
        passwordHash: 'x',
        roles: roles as never,
        emailVerifiedAt: verified ? new Date() : null,
      },
    });
    userIds.push(u.id);
    return { id: u.id, email: u.email, fullName: u.fullName, roles: roles as Role[] };
  }

  async function makeOrg(label: string, owner: RequestUser) {
    const org = await db!.organization.create({
      data: { name: `${label} ${tag}`, slug: `${label}-${tag}`, status: 'APPROVED' },
    });
    orgIds.push(org.id);
    await db!.organizationMember.create({
      data: { organizationId: org.id, userId: owner.id, role: 'ORGANIZER_OWNER' },
    });
    return org.id;
  }

  async function grant(orgId: string, quota = 100) {
    for (const key of [
      'campaigns.create',
      'campaigns.schedule',
      'campaigns.analytics.basic',
      'campaigns.analytics.advanced',
      'audience.advanced',
    ]) {
      await db!.entitlementOverride.create({
        data: {
          organizationId: orgId,
          key,
          boolValue: true,
          reason: 'test',
          grantedByUserId: ownerA.id,
        },
      });
    }
    await db!.entitlementOverride.create({
      data: {
        organizationId: orgId,
        key: 'campaigns.monthly_email_quota',
        intValue: quota,
        reason: 'test',
        grantedByUserId: ownerA.id,
      },
    });
  }

  async function makeEvent(orgId: string, city = 'Vijayawada') {
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `Hall ${city}`,
        city,
        country: 'India',
        timezone: 'Asia/Kolkata',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Show ${randomBytes(3).toString('hex')}`,
        slug: `show-${randomBytes(5).toString('hex')}`,
        category: 'Concert',
        /*
          DRAFT, never PUBLISHED: this suite shares the CI database with the end-to-end run
          that follows it, and a published event with no tickets is what that run's
          "pick a paid event" would choose.
        */
        status: 'DRAFT',
      },
    });
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
    const session = await db!.eventSession.create({
      data: { eventId: event.id, startsAt, endsAt: new Date(startsAt.getTime() + 7_200_000) },
    });
    return { eventId: event.id, sessionId: session.id };
  }

  const sessions: Record<string, string> = {};
  async function book(
    orgId: string,
    eventId: string,
    userId: string | null,
    email: string,
    opts: { confirmedAt?: Date; currency?: string; subtotal?: number; status?: string } = {},
  ) {
    return db!.booking.create({
      data: {
        organizationId: orgId,
        eventId,
        eventSessionId: sessions[eventId],
        userId,
        buyerName: 'Buyer',
        buyerEmail: email,
        status: (opts.status ?? 'CONFIRMED') as never,
        currency: opts.currency ?? 'INR',
        subtotalMinor: opts.subtotal ?? 1000,
        totalMinor: opts.subtotal ?? 1000,
        confirmedAt: opts.confirmedAt ?? new Date(),
        holdExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  }

  async function follow(orgId: string, u: RequestUser) {
    await db!.organizerFollow.create({
      data: { userId: u.id, organizationId: orgId, source: 'ORGANIZER_PAGE' },
    });
  }

  async function agree(
    orgId: string,
    u: RequestUser,
    granted = true,
    purpose = 'ORGANIZER_UPDATES',
  ) {
    await consent.record(
      { userId: u.id, email: u.email },
      { purpose, organizationId: orgId, granted },
      ctx,
    );
  }

  async function quotaUsed(orgId: string): Promise<number> {
    const r = await db!.usageLedger.aggregate({
      where: { organizationId: orgId, key: 'campaigns.monthly_email_quota' },
      _sum: { delta: true },
    });
    return -(r._sum.delta ?? 0);
  }

  /** Create, review, confirm and send now; then drive the worker until nothing is left. */
  async function launch(orgId: string, owner: RequestUser, extra: Record<string, unknown> = {}) {
    const c = await campaigns.create(owner, orgId, {
      templateKey: 'EVENT_ANNOUNCEMENT',
      eventId: orgId === orgA ? eventA : undefined,
      quietHours: null,
      audience: { sources: ['FOLLOWERS'] },
      ...extra,
    });
    const review = await campaigns.review(owner, orgId, c.id);
    expect(review.problems).toEqual([]);
    await campaigns.sendNow(owner, orgId, c.id, {
      version: c.version,
      confirmationToken: review.confirmationToken!,
    });
    const tick = await dispatch.tick();
    expect(tick.expand).toContain(c.id);
    await dispatch.expand(c.id);
    return c.id;
  }

  async function drain(campaignId: string) {
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const tick = await dispatch.tick();
      const mine = (
        await db!.campaignRecipient.findMany({
          where: { id: { in: tick.send }, campaignId },
          select: { id: true },
        })
      ).map((r: { id: string }) => r.id);
      if (mine.length === 0) break;
      for (const id of mine) outcomes.push(await dispatch.sendOne(id, { finalAttempt: true }));
    }
    await dispatch.tick();
    return outcomes;
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
      await db!.$queryRaw`SELECT 1 FROM "CampaignRecipient" LIMIT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable or not migrated');
      return;
    }
    const audit = new AuditService(db as never);
    const access = new OrgAccessService(db as never, audit);
    const entitlements = new EntitlementService(db as never, () => true);
    const suppression = new SuppressionService(db as never);
    consent = new CommunicationConsentService(
      db as never,
      audit,
      new MarketingConsentService(db as never),
      suppression,
    );
    const sinks = new ProviderEventSinks();
    const hooks = new UnsubscribeHooks();
    recorder = new DeliveryRecorderService(db as never, suppression, undefined, undefined, sinks);
    unsubscribe = new UnsubscribeService(db as never, config, consent, hooks);
    const audience = new CampaignAudienceService(db as never);
    const renderer = new CampaignRenderService(db as never, config);
    transport = new RecordingTransport();
    campaigns = new CampaignsService(
      db as never,
      config,
      audit,
      access,
      entitlements,
      audience,
      renderer,
      transport,
    );
    dispatch = new CampaignDispatchService(
      db as never,
      config,
      audit,
      entitlements,
      audience,
      renderer,
      transport,
    );
    events = new CampaignEventsService(db as never, config, suppression, consent, sinks, hooks);
    events.onModuleInit();
    analytics = new CampaignAnalyticsService(db as never, config, access, entitlements);
    admin = new CampaignAdminService(db as never, audit);

    ownerA = await makeUser('owner-a', ['ORGANIZER_OWNER'], true);
    ownerB = await makeUser('owner-b', ['ORGANIZER_OWNER'], true);
    ownerPlain = await makeUser('owner-plain', ['ORGANIZER_OWNER'], true);
    orgA = await makeOrg('org-a', ownerA);
    orgB = await makeOrg('org-b', ownerB);
    orgPlain = await makeOrg('org-plain', ownerPlain);
    await grant(orgA);
    await grant(orgB);

    const a = await makeEvent(orgA);
    eventA = a.eventId;
    sessions[eventA] = a.sessionId;
    const b = await makeEvent(orgB, 'Austin');
    eventB = b.eventId;
    sessions[eventB] = b.sessionId;

    for (const label of [
      'eligible',
      'nofollowconsent',
      'bounced',
      'unsubbed',
      'buyer',
      'withdrawn',
      'otherorg',
      'latewithdraw',
    ]) {
      people[label] = await makeUser(label);
    }
    // Followers of A.
    for (const l of [
      'eligible',
      'nofollowconsent',
      'bounced',
      'unsubbed',
      'withdrawn',
      'latewithdraw',
    ]) {
      await follow(orgA, people[l]);
    }
    await agree(orgA, people.eligible);
    await agree(orgA, people.bounced);
    await agree(orgA, people.unsubbed);
    await agree(orgA, people.latewithdraw);
    await agree(orgA, people.withdrawn);
    await agree(orgA, people.withdrawn, false);
    await suppression.suppress({
      channel: 'email',
      destination: people.bounced.email,
      reason: 'HARD_BOUNCE' as never,
    });
    await db!.organizerSuppression.create({
      data: {
        organizationId: orgA,
        channel: 'email',
        destinationHash: SuppressionService.hash('email', people.unsubbed.email),
        reason: 'UNSUBSCRIBED',
      },
    });
    // A repeat buyer of A with no consent at all: buying is not consent.
    await book(orgA, eventA, people.buyer.id, people.buyer.email);
    await book(orgA, eventA, people.buyer.id, people.buyer.email);
    // Org B's own follower, consented to B only.
    await follow(orgB, people.otherorg);
    await agree(orgB, people.otherorg);
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) {
      await db?.$disconnect();
      return;
    }
    // Best effort: leave the shared database as we found it. The usage ledger is append-only
    // by trigger, so its rows (plain ids, no foreign keys) stay.
    const org = { organizationId: { in: orgIds } };
    const campaignIds = (await db.campaign.findMany({ where: org, select: { id: true } })).map(
      (c: { id: string }) => c.id,
    );
    const byCampaign = { campaignId: { in: campaignIds } };
    const steps = [
      () => db!.campaignClick.deleteMany({ where: byCampaign }),
      () => db!.campaignLink.deleteMany({ where: byCampaign }),
      () => db!.campaignEvent.deleteMany({ where: byCampaign }),
      () => db!.campaignRecipient.deleteMany({ where: byCampaign }),
      () => db!.campaign.deleteMany({ where: org }),
      () => db!.savedSegment.deleteMany({ where: org }),
      () => db!.entitlementOverride.deleteMany({ where: org }),
      () => db!.communicationConsent.deleteMany({ where: org }),
      () => db!.organizerSuppression.deleteMany({ where: org }),
      () => db!.organizerFollow.deleteMany({ where: org }),
      () => db!.booking.deleteMany({ where: org }),
      () => db!.eventSession.deleteMany({ where: { event: org } }),
      () => db!.event.deleteMany({ where: org }),
      () => db!.venue.deleteMany({ where: org }),
      () => db!.organizationMember.deleteMany({ where: org }),
      () => db!.auditLog.deleteMany({ where: org }),
      () => db!.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } }),
      () => db!.marketingConsent.deleteMany({ where: { email: { contains: tag } } }),
      () =>
        db!.suppressedDestination.deleteMany({
          where: { destinationMask: { contains: '@example.test' }, createdAt: { gte: started } },
        }),
      () => db!.organization.deleteMany({ where: { id: { in: orgIds } } }),
      () => db!.user.deleteMany({ where: { id: { in: userIds } } }),
    ];
    for (const step of steps) {
      await step().catch(() => undefined);
    }
    await db.$disconnect();
  }, 120_000);

  const run = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  run('the audience preview counts nobody without consent and nobody suppressed', async () => {
    const followers = await campaigns.previewAudience(ownerA, orgA, {
      audience: { sources: ['FOLLOWERS'] },
      purpose: 'ORGANIZER_UPDATES',
    });
    expect(followers).toMatchObject({
      matched: 6,
      eligible: 2, // eligible, latewithdraw
      noConsent: 2, // a follow is not consent; a withdrawal is the newest row
      suppressedGlobal: 1,
      suppressedOrganizer: 1,
      estimatedCredits: 2,
      enoughQuota: true,
    });
    const buyers = await campaigns.previewAudience(ownerA, orgA, {
      audience: { sources: ['REPEAT_BUYERS'] },
      purpose: 'ORGANIZER_UPDATES',
    });
    // The repeat buyer is matched and NOT eligible: a purchase alone is never consent.
    expect(buyers).toMatchObject({ matched: 1, eligible: 0, noConsent: 1 });
    // Consent is per purpose: nobody said yes to offers.
    const offers = await campaigns.previewAudience(ownerA, orgA, {
      audience: { sources: ['FOLLOWERS'] },
      purpose: 'OFFERS',
    });
    expect(offers.eligible).toBe(0);
  });

  run(
    'tenancy: another organizer sees none of these people and cannot open the campaign',
    async () => {
      const b = await campaigns.previewAudience(ownerB, orgB, {
        audience: { sources: ['FOLLOWERS', 'EVENT_BUYERS'], eventIds: [eventA] },
        purpose: 'ORGANIZER_UPDATES',
      });
      // Only B's own follower. A's event id matches nobody for B.
      expect(b).toMatchObject({ matched: 1, eligible: 1 });
      const c = await campaigns.create(ownerA, orgA, {
        templateKey: 'THANK_YOU',
        quietHours: null,
      });
      await expect(campaigns.get(ownerB, orgA, c.id)).rejects.toThrow();
      await expect(campaigns.get(ownerB, orgB, c.id)).rejects.toThrow(/not found/i);
      await expect(
        campaigns.create(ownerA, orgA, { templateKey: 'EVENT_ANNOUNCEMENT', eventId: eventB }),
      ).rejects.toThrow(/not one of yours/);
    },
  );

  run('server-side plan and switch checks: no entitlement, no campaigns', async () => {
    await expect(
      campaigns.create(ownerPlain, orgPlain, { templateKey: 'THANK_YOU' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ENTITLEMENT_REQUIRED' }),
    });
    const status = await campaigns.status(ownerPlain, orgPlain);
    expect(status.entitlements.create).toBe(false);
    CONFIG.CAMPAIGNS_ENABLED = 'false';
    try {
      await expect(
        campaigns.create(ownerA, orgA, { templateKey: 'THANK_YOU' }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CAMPAIGNS_NOT_ENABLED' }),
      });
      expect((await dispatch.tick()).expand).toEqual([]);
    } finally {
      CONFIG.CAMPAIGNS_ENABLED = 'true';
    }
  });

  run('send without a fresh review is refused; an edit after review voids the token', async () => {
    const c = await campaigns.create(ownerA, orgA, { templateKey: 'THANK_YOU', quietHours: null });
    await expect(
      campaigns.sendNow(ownerA, orgA, c.id, { version: c.version, confirmationToken: 'nope' }),
    ).rejects.toThrow(/Review the campaign again/);
    const review = await campaigns.review(ownerA, orgA, c.id);
    const edited = await campaigns.update(ownerA, orgA, c.id, {
      version: c.version,
      subject: 'Changed',
    });
    await expect(
      campaigns.sendNow(ownerA, orgA, c.id, {
        version: edited.version,
        confirmationToken: review.confirmationToken!,
      }),
    ).rejects.toThrow(/Review the campaign again/);
    // Optimistic lock: a stale version is refused.
    await expect(
      campaigns.update(ownerA, orgA, c.id, { version: c.version, subject: 'Again' }),
    ).rejects.toThrow(/Somebody else changed/);
  });

  run('quiet hours: scheduling into them and sending during them are refused', async () => {
    const now = new Date();
    const hh = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    const quiet = {
      start: hh(new Date(now.getTime() - 3600_000)),
      end: hh(new Date(now.getTime() + 3 * 3600_000)),
    };
    const c = await campaigns.create(ownerA, orgA, {
      templateKey: 'THANK_YOU',
      timezone: 'UTC',
      quietHours: quiet,
    });
    const review = await campaigns.review(ownerA, orgA, c.id);
    expect(review.quietHoursNow).toBe(true);
    await expect(
      campaigns.sendNow(ownerA, orgA, c.id, {
        version: c.version,
        confirmationToken: review.confirmationToken!,
      }),
    ).rejects.toThrow(/quiet hours/);
    await expect(
      campaigns.schedule(ownerA, orgA, c.id, {
        version: c.version,
        confirmationToken: review.confirmationToken!,
        scheduledAt: new Date(now.getTime() + 3600_000).toISOString(),
      }),
    ).rejects.toThrow(/inside your quiet hours/);
  });

  let mainCampaign = '';
  run(
    'end to end: consent withdrawn after the list was built is honoured at send time; one credit per accept',
    async () => {
      const before = await quotaUsed(orgA);
      mainCampaign = await launch(orgA, ownerA);
      const rows = await db!.campaignRecipient.findMany({ where: { campaignId: mainCampaign } });
      const byStatus = (s: string) => rows.filter((r: { status: string }) => r.status === s).length;
      expect(byStatus('PENDING')).toBe(2);
      expect(byStatus('SKIPPED_CONSENT')).toBe(2);
      expect(byStatus('SKIPPED_SUPPRESSED')).toBe(2);
      // A skipped person's address is never stored.
      expect(
        rows.filter(
          (r: { status: string; destination: string | null }) =>
            r.status !== 'PENDING' && r.destination,
        ),
      ).toEqual([]);

      // The person changes their mind after the list was built.
      await agree(orgA, people.latewithdraw, false);
      const outcomes = await drain(mainCampaign);
      expect(outcomes.sort()).toEqual(['accepted', 'skipped_consent']);
      expect(transport.sent.map((m) => m.to)).toContain(people.eligible.email);
      expect(transport.sent.map((m) => m.to)).not.toContain(people.latewithdraw.email);
      expect(await quotaUsed(orgA)).toBe(before + 1);

      const c = await db!.campaign.findUnique({ where: { id: mainCampaign } });
      expect(c.status).toBe('COMPLETED');
      const sent = transport.sent.find((m) => m.to === people.eligible.email)!;
      expect(sent.listUnsubscribe['List-Unsubscribe']).toMatch(
        /^<https:\/\/api\.example\.test\/api\/public\/unsubscribe\/.+>$/,
      );
      expect(sent.listUnsubscribe['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(sent.from).toMatch(/via ETicketsGo" <tickets@eticketsgo\.test>$/);
      expect(sent.configurationSet).toBe('qa-transactional');
      // Accepted: the address is minimised away.
      const accepted = await db!.campaignRecipient.findFirst({
        where: { campaignId: mainCampaign, status: 'ACCEPTED' },
      });
      expect(accepted.destination).toBeNull();
      expect(accepted.providerMessageId).toMatch(/^msg-/);
    },
  );

  run('no duplicate send: rerunning expand and the send job does nothing more', async () => {
    const sentBefore = transport.sent.length;
    const usedBefore = await quotaUsed(orgA);
    await db!.campaign.update({ where: { id: mainCampaign }, data: { status: 'QUEUED' } });
    expect((await dispatch.expand(mainCampaign)).inserted).toBe(0);
    const ids = (await db!.campaignRecipient.findMany({ where: { campaignId: mainCampaign } })).map(
      (r: { id: string }) => r.id,
    );
    for (const id of ids) expect(await dispatch.sendOne(id)).toBe('already_final');
    expect(transport.sent.length).toBe(sentBefore);
    expect(await quotaUsed(orgA)).toBe(usedBefore);
    await db!.campaign.update({ where: { id: mainCampaign }, data: { status: 'COMPLETED' } });
    // The unique index is the backstop.
    const one = await db!.campaignRecipient.findFirst({ where: { campaignId: mainCampaign } });
    await expect(
      db!.campaignRecipient.create({
        data: {
          campaignId: mainCampaign,
          organizationId: orgA,
          emailHash: one.emailHash,
          destinationMask: 'x',
        },
      }),
    ).rejects.toThrow();
  });

  run('a crash between the provider call and the record is never resent', async () => {
    const r = await db!.campaignRecipient.findFirst({
      where: { campaignId: mainCampaign, status: 'ACCEPTED' },
    });
    await db!.campaign.update({ where: { id: mainCampaign }, data: { status: 'SENDING' } });
    await db!.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'QUEUED', lastError: 'IN_FLIGHT', destination: people.eligible.email },
    });
    const sentBefore = transport.sent.length;
    expect(await dispatch.sendOne(r.id)).toBe('unknown_outcome');
    expect(transport.sent.length).toBe(sentBefore);
    await db!.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'ACCEPTED', lastError: null, destination: null },
    });
    await db!.campaign.update({ where: { id: mainCampaign }, data: { status: 'COMPLETED' } });
  });

  run('credits are spent only when the provider accepts: a rejection spends nothing', async () => {
    const extra = await makeUser('rejected');
    await follow(orgA, extra);
    await agree(orgA, extra);
    transport.behaviour.set(extra.email, 'reject');
    const before = await quotaUsed(orgA);
    const id = await launch(orgA, ownerA);
    const outcomes = await drain(id);
    expect(outcomes.sort()).toEqual(['accepted', 'rejected']);
    expect(await quotaUsed(orgA)).toBe(before + 1);
    const c = await db!.campaign.findUnique({ where: { id } });
    expect(c.status).toBe('PARTIALLY_FAILED');
    transport.behaviour.delete(extra.email);
    await agree(orgA, extra, false);
  });

  run(
    'a transient error is retried; the last attempt fails the recipient without spending',
    async () => {
      transport.behaviour.set(people.eligible.email, 'transient');
      const before = await quotaUsed(orgA);
      const id = await launch(orgA, ownerA);
      const tick = await dispatch.tick();
      const mine = await db!.campaignRecipient.findFirst({
        where: { campaignId: id, status: 'QUEUED' },
      });
      expect(tick.send).toContain(mine.id);
      await expect(dispatch.sendOne(mine.id, { finalAttempt: false })).rejects.toBeInstanceOf(
        RetryableSendError,
      );
      expect(await dispatch.sendOne(mine.id, { finalAttempt: true })).toBe('failed');
      expect(await quotaUsed(orgA)).toBe(before);
      transport.behaviour.delete(people.eligible.email);
      await drain(id);
      expect((await db!.campaign.findUnique({ where: { id } })).status).toBe('FAILED');
    },
  );

  run(
    'pause stops dispatch, in-flight jobs no-op, cancel ends it and drops the kept addresses',
    async () => {
      const id = await launch(orgA, ownerA);
      const tick = await dispatch.tick();
      const queued = await db!.campaignRecipient.findMany({
        where: { campaignId: id, status: 'QUEUED' },
      });
      expect(queued.length).toBe(1);
      expect(tick.send).toContain(queued[0].id);
      const c = await db!.campaign.findUnique({ where: { id } });
      await campaigns.pause(ownerA, orgA, id, c.version);
      const sentBefore = transport.sent.length;
      expect(await dispatch.sendOne(queued[0].id)).toBe('not_sending');
      expect(transport.sent.length).toBe(sentBefore);
      const afterPause = await dispatch.tick();
      expect(afterPause.send.filter((s) => s === queued[0].id)).toEqual([]);
      const paused = await db!.campaign.findUnique({ where: { id } });
      await expect(campaigns.cancel(ownerA, orgA, id, paused.version - 1)).rejects.toThrow(
        /Somebody else/,
      );
      await campaigns.cancel(ownerA, orgA, id, paused.version);
      expect((await db!.campaign.findUnique({ where: { id } })).status).toBe('CANCELLED');
      expect(
        (await db!.campaignRecipient.findUnique({ where: { id: queued[0].id } })).destination,
      ).toBeNull();
      expect(await dispatch.sendOne(queued[0].id)).toBe('not_sending');
      expect(transport.sent.length).toBe(sentBefore);
    },
  );

  run('an account-level refusal pauses the campaign and puts the recipient back', async () => {
    transport.behaviour.set(people.eligible.email, 'paused');
    const id = await launch(orgA, ownerA);
    await dispatch.tick();
    const r = await db!.campaignRecipient.findFirst({
      where: { campaignId: id, status: 'QUEUED' },
    });
    expect(await dispatch.sendOne(r.id)).toBe('provider_paused');
    const c = await db!.campaign.findUnique({ where: { id } });
    expect(c.status).toBe('PAUSED');
    expect(c.pausedReason).toMatch(/PROVIDER_REFUSED/);
    expect((await db!.campaignRecipient.findUnique({ where: { id: r.id } })).status).toBe('QUEUED');
    transport.behaviour.delete(people.eligible.email);
    await campaigns.cancel(ownerA, orgA, id, c.version);
  });

  run('admin pause: audited, and the organizer cannot resume it', async () => {
    const id = await launch(orgA, ownerA);
    await admin.pause(ownerB.id, id, 'Reported as spam');
    const c = await db!.campaign.findUnique({ where: { id } });
    expect(c.status).toBe('PAUSED');
    await expect(campaigns.resume(ownerA, orgA, id, c.version)).rejects.toThrow(
      /ETicketsGo paused/,
    );
    const audit = await db!.auditLog.findFirst({
      where: { entityId: id, action: 'CAMPAIGN_PAUSED_BY_ADMIN' },
    });
    expect(audit).toBeTruthy();
    await admin.release(ownerB.id, id);
    const after = await db!.campaign.findUnique({ where: { id } });
    expect(after.status).toBe('QUEUED');
    await campaigns.pause(ownerA, orgA, id, after.version);
    await campaigns.cancel(ownerA, orgA, id, after.version + 1);
  });

  run(
    'SES events map onto the recipient, a replay is one row, bounces and complaints suppress',
    async () => {
      const r = await db!.campaignRecipient.findFirst({
        where: { campaignId: mainCampaign, status: 'ACCEPTED' },
      });
      const deliver = {
        provider: 'ses',
        providerMessageId: r.providerMessageId,
        eventId: `${r.providerMessageId}:Delivery`,
        state: DeliveryState.DELIVERED,
        providerStatus: 'Delivery',
      };
      expect(await recorder.applyProviderEvent(deliver)).toBe('applied');
      expect(await recorder.applyProviderEvent(deliver)).toBe('ignored');
      expect(
        await db!.campaignEvent.count({ where: { recipientId: r.id, type: 'DELIVERED' } }),
      ).toBe(1);
      expect((await db!.campaignRecipient.findUnique({ where: { id: r.id } })).status).toBe(
        'DELIVERED',
      );
      // An unknown message is still unknown: held for correlation, as before.
      expect(
        await recorder.applyProviderEvent({
          ...deliver,
          providerMessageId: 'nobody',
          eventId: 'nobody:Delivery',
        }),
      ).toBe('unknown');

      // A hard bounce on a second accepted message suppresses the address platform-wide.
      const bouncer = await makeUser('bouncer');
      await follow(orgA, bouncer);
      await agree(orgA, bouncer);
      const id = await launch(orgA, ownerA);
      await drain(id);
      const br = await db!.campaignRecipient.findFirst({
        where: { campaignId: id, emailHash: SuppressionService.hash('email', bouncer.email) },
      });
      expect(
        await recorder.applyProviderEvent({
          provider: 'ses',
          providerMessageId: br.providerMessageId,
          eventId: `${br.providerMessageId}:Bounce:0`,
          state: DeliveryState.BOUNCED,
          providerStatus: 'Bounce',
          failureCode: 'Permanent',
        }),
      ).toBe('applied');
      expect((await db!.campaignRecipient.findUnique({ where: { id: br.id } })).status).toBe(
        'BOUNCED',
      );
      expect(
        await db!.suppressedDestination.findFirst({
          where: {
            channel: 'email',
            destinationHash: SuppressionService.hash('email', bouncer.email),
          },
        }),
      ).toBeTruthy();

      // A complaint: platform suppression, organizer suppression, consent withdrawn.
      const er = await db!.campaignRecipient.findFirst({
        where: {
          campaignId: id,
          emailHash: SuppressionService.hash('email', people.eligible.email),
        },
      });
      expect(
        await recorder.applyProviderEvent({
          provider: 'ses',
          providerMessageId: er.providerMessageId,
          eventId: `${er.providerMessageId}:Complaint:0`,
          state: DeliveryState.COMPLAINED,
          providerStatus: 'Complaint',
        }),
      ).toBe('applied');
      expect((await db!.campaignRecipient.findUnique({ where: { id: er.id } })).status).toBe(
        'COMPLAINED',
      );
      expect(
        await db!.organizerSuppression.findFirst({
          where: {
            organizationId: orgA,
            destinationHash: SuppressionService.hash('email', people.eligible.email),
          },
        }),
      ).toBeTruthy();
      const state = await consent.organizerState(
        { userId: people.eligible.id, email: people.eligible.email },
        orgA,
      );
      expect(state.ORGANIZER_UPDATES.granted).toBe(false);

      // Put the main recipient back in a mailable state for the tests below.
      await db!.organizerSuppression.deleteMany({
        where: {
          organizationId: orgA,
          destinationHash: SuppressionService.hash('email', people.eligible.email),
        },
      });
      await db!.suppressedDestination.deleteMany({
        where: { destinationHash: SuppressionService.hash('email', people.eligible.email) },
      });
      await agree(orgA, people.eligible);
    },
  );

  run('the unsubscribe link in the rendered email works end to end', async () => {
    const helper = await makeUser('unsub-e2e');
    await follow(orgA, helper);
    await agree(orgA, helper);
    const id = await launch(orgA, ownerA);
    await drain(id);
    const msg = transport.sent.filter((m) => m.to === helper.email).pop()!;
    const token = /\/unsubscribe\/([A-Za-z0-9_\-.]+)"/.exec(msg.html)![1];
    expect(msg.text).toContain(`/unsubscribe/${token}`);
    const res = await unsubscribe.unsubscribe(token, { oneClick: true });
    expect(res.unsubscribed).toBe(true);
    const r = await db!.campaignRecipient.findFirst({
      where: { campaignId: id, emailHash: SuppressionService.hash('email', helper.email) },
    });
    expect(r.status).toBe('UNSUBSCRIBED');
    expect(
      await db!.campaignEvent.count({ where: { recipientId: r.id, type: 'UNSUBSCRIBED' } }),
    ).toBe(1);
    const preview = await campaigns.previewAudience(ownerA, orgA, {
      audience: { sources: ['FOLLOWERS'] },
      purpose: 'ORGANIZER_UPDATES',
    });
    // Withdrawn consent is the newest row, so the person now counts as "no consent".
    const again = await campaigns.campaignAudience(ownerA, orgA, id);
    expect(again.eligible).toBe(preview.eligible);
    const stats = await analytics.campaignStats(ownerA, orgA, id);
    expect(stats.unsubscribed).toBe(1);
  });

  run(
    'clicks are tracked through our redirect; attribution is per currency, last click, inside the window',
    async () => {
      const buyer = await makeUser('clicker');
      await follow(orgA, buyer);
      await agree(orgA, buyer);
      const id = await launch(orgA, ownerA);
      await drain(id);
      const msg = transport.sent.filter((m) => m.to === buyer.email).pop()!;
      const tracked =
        /https:\/\/api\.example\.test\/api\/public\/campaign-links\/([A-Za-z0-9_\-.]+)/.exec(
          msg.html,
        )!;
      expect(msg.html).not.toContain(`href="https://shop.example.test/events/`);
      const clickedAt = new Date(Date.now() - 5 * 86_400_000);
      const target = await events.click(tracked[1], clickedAt);
      expect(target).toMatch(/^https:\/\/shop\.example\.test\/events\//);
      expect(await events.click(tracked[1], clickedAt)).toBe(target);
      expect(await events.click(`${tracked[1]}x`)).toBeNull();
      expect(await db!.campaignClick.count({ where: { campaignId: id } })).toBe(1);

      await book(orgA, eventA, buyer.id, buyer.email, {
        confirmedAt: new Date(clickedAt.getTime() + 2 * 86_400_000),
        currency: 'INR',
        subtotal: 50_000,
      });
      // A guest checkout with the same address counts (matched by email hash).
      await book(orgA, eventA, null, buyer.email.toUpperCase(), {
        confirmedAt: new Date(clickedAt.getTime() + 3 * 86_400_000),
        currency: 'USD',
        subtotal: 2_500,
      });
      // Outside the 7-day window, and a refunded one: neither counts.
      await book(orgA, eventA, buyer.id, buyer.email, {
        confirmedAt: new Date(clickedAt.getTime() + 8 * 86_400_000),
        currency: 'INR',
        subtotal: 99_999,
      });
      await book(orgA, eventA, buyer.id, buyer.email, {
        confirmedAt: new Date(clickedAt.getTime() + 1 * 86_400_000),
        currency: 'INR',
        subtotal: 77_777,
        status: 'REFUNDED',
      });
      // Delivered, so the click rate has a denominator.
      const r = await db!.campaignRecipient.findFirst({
        where: { campaignId: id, emailHash: SuppressionService.hash('email', buyer.email) },
      });
      await recorder.applyProviderEvent({
        provider: 'ses',
        providerMessageId: r.providerMessageId,
        eventId: `${r.providerMessageId}:Delivery`,
        state: DeliveryState.DELIVERED,
        providerStatus: 'Delivery',
      });
      const stats = await analytics.campaignStats(ownerA, orgA, id);
      expect(stats.uniqueClicks).toBe(1);
      expect(stats.attribution!.model).toBe('LAST_CLICK');
      expect(stats.attribution!.byCurrency).toEqual([
        {
          currency: 'INR',
          orders: 1,
          ticketRevenueMinor: 50_000,
          revenuePerDeliveredMinor: expect.any(Number),
        },
        {
          currency: 'USD',
          orders: 1,
          ticketRevenueMinor: 2_500,
          revenuePerDeliveredMinor: expect.any(Number),
        },
      ]);
      // A wider window takes in the eighth day.
      const wide = await analytics.campaignStats(ownerA, orgA, id, { windowDays: 10 });
      expect(wide.attribution!.byCurrency.find((x) => x.currency === 'INR')).toMatchObject({
        orders: 2,
        ticketRevenueMinor: 149_999,
      });

      // The overview and its CSV are aggregates; another organizer cannot read them.
      const overview = await analytics.overview(ownerA, orgA, {});
      expect(overview.followers.total).toBeGreaterThanOrEqual(6);
      const csv = await analytics.exportCsv(ownerA, orgA, {});
      expect(csv).not.toContain('@example.test');
      await expect(analytics.overview(ownerB, orgA, {})).rejects.toThrow();
    },
  );

  run(
    'test sends: own or a team member’s verified address, or the SES simulator; never anybody else',
    async () => {
      const c = await campaigns.create(ownerA, orgA, {
        templateKey: 'THANK_YOU',
        quietHours: null,
      });
      await expect(
        campaigns.testSend(ownerA, orgA, c.id, { to: [people.eligible.email] }),
      ).rejects.toThrow(/verified/);
      const before = await quotaUsed(orgA);
      const r = await campaigns.testSend(ownerA, orgA, c.id, {
        to: [ownerA.email, 'success@simulator.amazonses.com'],
      });
      expect(r.sent).toBe(2);
      const last = transport.sent[transport.sent.length - 1];
      expect(last.subject).toMatch(/^\[Test\] /);
      expect(last.html).toContain('This is a test email');
      expect(await quotaUsed(orgA)).toBe(before);
      CONFIG.APP_ENV = 'PRODUCTION';
      try {
        await expect(
          campaigns.testSend(ownerA, orgA, c.id, { to: ['success@simulator.amazonses.com'] }),
        ).rejects.toThrow();
      } finally {
        CONFIG.APP_ENV = 'QA';
      }
    },
  );
});
