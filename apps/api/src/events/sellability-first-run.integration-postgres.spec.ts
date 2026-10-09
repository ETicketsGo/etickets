import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationService } from '../notifications/notification.service';
import { AdminAudienceService } from '../notifications/admin-audience.service';
import { NotificationTemplateService } from '../notifications/templates/notification-template.service';
import { EventSellabilitySweepService } from './event-sellability-sweep.service';
import type { SellabilityIssue, SellabilityReport } from './event-sellability.service';

/**
 * integration-real-postgres - the first run after messages became per cause adds nothing the
 * organizer was already told.
 *
 * ── WHY THIS CANNOT BE PROVEN WITH A MOCK ──────────────────────────────────────────
 * The earlier sweep stored one row per event per owner per channel, keyed on the "+"-joined
 * code set. Whether the new sweep then writes a SECOND message about the same fault is a
 * question about what ends up in the table: the stored payload's JSON path match, the dedupe
 * index, the email and in-app siblings. So the old rows are written here through the real
 * notification service, exactly as the old sweep would have written them, and the rows are
 * counted afterwards.
 *
 * Only the sellability verdict, the event list and delivery are stubbed. The admin audience
 * is real except for WHO the admins are: the real list would page every admin in this shared
 * database. Skips (never fabricates a pass) when no database is reachable.
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

const shows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    startsAt: new Date(Date.UTC(2030, 0, 1 + i, 13, 30)).toISOString(),
    timeZone: 'Asia/Kolkata',
  }));

const BALCONY: SellabilityIssue = {
  code: 'SEAT_CLASS_UNMAPPED',
  owner: 'ORGANIZER',
  message: 'Balcony is not mapped to a regulatory seat class.',
  fix: 'Map every seat category to a regulatory class.',
  fixPath: '/organizer/cinemas/c1/readiness',
  subject: 'Balcony',
  affectedSessions: 4,
  sessions: shows(4),
};

const RECLINER: SellabilityIssue = {
  code: 'PRICE_OVER_CEILING',
  owner: 'ORGANIZER',
  message: 'Recliner is priced above what its seat class permits.',
  fix: 'Lower the price.',
  fixPath: '/organizer/events/e1/sessions',
  subject: 'Recliner',
  affectedSessions: 2,
  sessions: shows(2),
};

// Never named by the old message below: genuinely new news.
const NO_SEATS: SellabilityIssue = {
  code: 'SEATED_SESSION_HAS_NO_SEATS',
  owner: 'ORGANIZER',
  message: 'The room has no seats that can be sold.',
  fix: 'Add seats to the layout.',
  fixPath: '/organizer/venues',
  affectedSessions: 1,
  sessions: shows(1),
};

const NO_POLICY: SellabilityIssue = {
  code: 'NO_PRICING_POLICY',
  owner: 'PLATFORM',
  message: 'No pricing policy covers Telangana on 2026-10-09.',
  fix: 'Nothing here can fix this.',
  fixPath: null,
  affectedSessions: 6,
  sessions: shows(6),
};

describe('integration-real-postgres: first sellability run after the per-cause change', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;

  const suffix = `firstrun-${Date.now()}`;
  // Not a real event: the sweep's event list and verdict are stubbed. Unique to this run.
  const EVENT_ID = `evt-${suffix}`;
  const TITLE = `Telugu Movie ${suffix}`;
  let ownerId = '';
  let newOwnerId = '';
  let adminId = '';
  let orgId = '';

  let current: SellabilityReport;
  let sweep: EventSellabilitySweepService;
  let notifications: NotificationService;

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
    const mkUser = (who: string, roles: string[]) =>
      db.user.create({
        data: { email: `${who}+${suffix}@example.test`, passwordHash: 'x', fullName: who, roles },
      });
    const owner = await mkUser('owner', ['ORGANIZER_OWNER']);
    const newOwner = await mkUser('newowner', ['ORGANIZER_OWNER']);
    const admin = await mkUser('admin', ['ADMIN']);
    ownerId = owner.id;
    newOwnerId = newOwner.id;
    adminId = admin.id;
    const org = await db.organization.create({
      data: { name: `Org ${suffix}`, slug: `org-${suffix}` },
    });
    orgId = org.id;

    const deliver = jest.fn().mockResolvedValue({ provider: 'log', providerMessageId: 'log-1' });
    notifications = new NotificationService(
      db as never,
      new NotificationTemplateService(),
      { resolveChannels: async (_u: unknown, _t: unknown, req: string[]) => req } as never,
      {
        has: (c: string) => ['email', 'in_app'].includes(c),
        resolve: (c: string) => ({ key: c, deliver }),
      } as never,
      { mayReceiveMarketing: jest.fn().mockResolvedValue(false) } as never,
    );
    const audience = new AdminAudienceService(db as never, notifications);
    // The real query would page every admin in this shared database.
    audience.admins = async () => [{ id: admin.id, email: admin.email }];

    sweep = new EventSellabilitySweepService(
      {
        event: {
          findMany: async () => [{ id: EVENT_ID, title: TITLE, organizationId: orgId }],
        },
        notification: db.notification,
      } as never,
      { check: async () => current } as never,
      audience,
    );
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    const userIds = [ownerId, newOwnerId, adminId].filter(Boolean);
    await db.notification.deleteMany({ where: { userId: { in: userIds } } });
    await db.organizationMember.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await db.$disconnect();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      120_000,
    );

  const rowsFor = (userId: string) =>
    db.notification.findMany({
      where: {
        userId,
        type: 'EVENT_NOT_SELLABLE',
        payload: { path: ['eventId'], equals: EVENT_ID },
      },
      orderBy: { createdAt: 'asc' },
    });

  maybe('announces only the cause the old message never named, and only once', async () => {
    /*
      What the earlier sweep wrote, field for field: one message per event per owner, every
      fault in one paragraph, keyed on the sorted code set. And the platform's copy, whose
      shape the per-cause change did not touch.
    */
    await db.organizationMember.create({
      data: { organizationId: orgId, userId: ownerId, role: 'ORGANIZER_OWNER' },
    });
    await notifications.send({
      type: NotificationType.EVENT_NOT_SELLABLE,
      userId: ownerId,
      toEmail: `owner+${suffix}@example.test`,
      payload: {
        eventId: EVENT_ID,
        eventTitle: TITLE,
        reason: `${BALCONY.message} ${RECLINER.message} ${NO_POLICY.message}`,
        blockerCodes: 'NO_PRICING_POLICY+PRICE_OVER_CEILING+SEAT_CLASS_UNMAPPED',
      },
    });
    await notifications.send({
      type: NotificationType.EVENT_NOT_SELLABLE,
      userId: adminId,
      toEmail: `admin+${suffix}@example.test`,
      payload: {
        eventId: EVENT_ID,
        eventTitle: TITLE,
        organizationId: orgId,
        reason: NO_POLICY.message,
        affectedSessions: NO_POLICY.affectedSessions,
        blockerCodes: 'NO_PRICING_POLICY',
      },
    });
    const ownerBefore = await rowsFor(ownerId);
    const adminBefore = await rowsFor(adminId);
    // The old message reached both channels, or this test is not testing the real shape.
    expect(ownerBefore.map((r: { channel: string }) => r.channel).sort()).toEqual([
      'email',
      'in_app',
    ]);
    expect(adminBefore.length).toBeGreaterThan(0);

    // An owner who joined after the old message went out.
    await db.organizationMember.create({
      data: { organizationId: orgId, userId: newOwnerId, role: 'ORGANIZER_OWNER' },
    });

    // The first run of the new sweep: three standing faults and one new one.
    current = {
      eventId: EVENT_ID,
      sellable: false,
      blockers: [BALCONY, RECLINER, NO_POLICY, NO_SEATS],
      warnings: [],
      checkedAt: new Date().toISOString(),
    };
    await sweep.sweep();

    const ownerAfter = await rowsFor(ownerId);
    const added = ownerAfter.slice(ownerBefore.length);
    // Exactly the new cause, once per channel. Nothing about the three already named.
    expect(added.map((r: { payload: { blockerCode: string } }) => r.payload.blockerCode)).toEqual([
      'SEATED_SESSION_HAS_NO_SEATS',
      'SEATED_SESSION_HAS_NO_SEATS',
    ]);
    expect(added.map((r: { channel: string }) => r.channel).sort()).toEqual(['email', 'in_app']);

    // The platform's copy keeps the key it always had, so the first run adds no admin row.
    expect(await rowsFor(adminId)).toHaveLength(adminBefore.length);

    // The owner who was never told anything hears about every cause, once each.
    const fresh = await rowsFor(newOwnerId);
    const inApp = fresh.filter((r: { channel: string }) => r.channel === 'in_app');
    expect(inApp.map((r: { payload: { blockerCode: string } }) => r.payload.blockerCode)).toEqual([
      'SEAT_CLASS_UNMAPPED',
      'PRICE_OVER_CEILING',
      'NO_PRICING_POLICY',
      'SEATED_SESSION_HAS_NO_SEATS',
    ]);

    // The old rows are exactly as they were sent.
    const oldNow = ownerAfter.slice(0, ownerBefore.length);
    expect(oldNow.map((r: { payload: unknown }) => r.payload)).toEqual(
      ownerBefore.map((r: { payload: unknown }) => r.payload),
    );

    // A second run adds nothing for anybody.
    await sweep.sweep();
    expect(await rowsFor(ownerId)).toHaveLength(ownerAfter.length);
    expect(await rowsFor(newOwnerId)).toHaveLength(fresh.length);
    expect(await rowsFor(adminId)).toHaveLength(adminBefore.length);
  });
});
