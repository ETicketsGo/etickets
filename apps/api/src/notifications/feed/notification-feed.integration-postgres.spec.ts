import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotificationService } from '../notification.service';
import { AdminAudienceService } from '../admin-audience.service';
import { NotificationTemplateService } from '../templates/notification-template.service';
import { EventSellabilitySweepService } from '../../events/event-sellability-sweep.service';
import type { SellabilityIssue, SellabilityReport } from '../../events/event-sellability.service';
import { NotificationFeedService } from './notification-feed.service';

/**
 * integration-real-postgres - one cause, one stored message, one card; and nothing deleted.
 *
 * ── WHY THIS CANNOT BE PROVEN WITH A MOCK ──────────────────────────────────────────
 * "A cause that persists is not announced again" is a claim about the unique index on the
 * dedupe key, and "the page folds without rewriting history" is a claim about what is left in
 * the table afterwards. Both are only true or false of a real database.
 *
 * The sweep runs through the REAL audience fan-out and the REAL notification service, against
 * an organization created here; only the sellability verdict and delivery are stubbed. Skips
 * (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../.env', '../../../../../.env']) {
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
    startsAt: new Date(Date.UTC(2026, 10, 1 + i, 13, 30)).toISOString(),
    timeZone: 'Asia/Kolkata',
  }));

const BALCONY: SellabilityIssue = {
  code: 'SEAT_CLASS_UNMAPPED',
  owner: 'ORGANIZER',
  message: 'Balcony is not mapped to a regulatory seat class.',
  fix: 'Map every seat category to a regulatory class.',
  fixPath: '/organizer/cinemas/c1/readiness',
  subject: 'Balcony',
  affectedSessions: 18,
  sessions: shows(18),
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

describe('integration-real-postgres: notification centre folding', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;

  const suffix = `feed-${Date.now()}`;
  const EMAIL = `owner+${suffix}@example.test`;
  // Not a real event: the sweep reads its verdict from the stub below, and the feed's live
  // check is pointed at the same stub. Unique so no other suite's rows can match it.
  const EVENT_ID = `evt-${suffix}`;
  let userId = '';
  let orgId = '';

  let current: SellabilityReport;
  const verdict = (blockers: SellabilityIssue[]): SellabilityReport => ({
    eventId: EVENT_ID,
    sellable: blockers.length === 0,
    blockers,
    warnings: [],
    checkedAt: new Date().toISOString(),
  });

  let sweep: EventSellabilitySweepService;
  let feed: NotificationFeedService;
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
    const user = await db.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Feed Owner', roles: ['ORGANIZER_OWNER'] },
    });
    userId = user.id;
    const org = await db.organization.create({
      data: { name: `Org ${suffix}`, slug: `org-${suffix}` },
    });
    orgId = org.id;
    await db.organizationMember.create({
      data: { organizationId: orgId, userId, role: 'ORGANIZER_OWNER' },
    });

    const deliver = jest.fn().mockResolvedValue({ provider: 'log', providerMessageId: 'log-1' });
    const templates = new NotificationTemplateService();
    notifications = new NotificationService(
      db as never,
      templates,
      { resolveChannels: async (_u: unknown, _t: unknown, req: string[]) => req } as never,
      {
        has: (c: string) => ['email', 'in_app'].includes(c),
        resolve: (c: string) => ({ key: c, deliver }),
      } as never,
      { mayReceiveMarketing: jest.fn().mockResolvedValue(false) } as never,
    );
    const audience = new AdminAudienceService(db as never, notifications);
    const sellability = { check: async () => current };
    sweep = new EventSellabilitySweepService(
      {
        event: {
          findMany: async () => [
            { id: EVENT_ID, title: `Telugu Movie ${suffix}`, organizationId: orgId },
          ],
        },
      } as never,
      sellability as never,
      // Admins are not under test; the real fan-out would message every admin in the DB.
      {
        notifyAdmins: async () => 0,
        notifyOrganizationOwners: audience.notifyOrganizationOwners.bind(audience),
      } as never,
    );
    feed = new NotificationFeedService(
      {
        notification: db.notification,
        // The event is the stub's, so is its status: on sale, with shows to come.
        event: { findUnique: async () => ({ status: 'PUBLISHED', sessions: [{ id: 's1' }] }) },
      } as never,
      templates,
      notifications,
      sellability as never,
    );
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
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

  const inApp = () =>
    db.notification.findMany({
      where: { userId, channel: 'in_app', type: 'EVENT_NOT_SELLABLE' },
      orderBy: { createdAt: 'asc' },
    });

  maybe('stores one message per cause, and a persisting cause is not stored again', async () => {
    current = verdict([BALCONY]);
    await sweep.sweep();
    await sweep.sweep();
    expect(await inApp()).toHaveLength(1);

    // A new cause appears beside the old one: the new one is told, the old one is not again.
    current = verdict([BALCONY, RECLINER]);
    await sweep.sweep();
    const rows = await inApp();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { payload: { blockerCode: string } }) => r.payload.blockerCode)).toEqual([
      'SEAT_CLASS_UNMAPPED',
      'PRICE_OVER_CEILING',
    ]);

    /*
      Standing in for the worker's dispatch, which is a GLOBAL sweep of every due message and
      would deliver other suites' rows through this suite's mock. Only these rows, and only
      the status: the inbox lists what was delivered.
    */
    await db.notification.updateMany({
      where: { userId, channel: 'in_app' },
      data: { status: 'SENT', sentAt: new Date() },
    });
  });

  maybe('folds them into one card per cause, with the affected shows listed', async () => {
    const result = await feed.feed(userId, 'ORGANIZER');
    const action = result.sections.find((s) => s.category === 'ACTION_REQUIRED');
    expect(action).toBeDefined();
    expect(action!.groups).toHaveLength(2);
    const balcony = action!.groups.find((g) => g.summary.startsWith('Balcony'))!;
    expect(balcony.sessions).toHaveLength(18);
    expect(balcony.summary).toBe(
      'Balcony seats need a regulatory seat class. 18 showtimes affected.',
    );
    expect(balcony.resolved).toBe(false);
    expect(balcony.action?.href).toBe('/organizer/cinemas/c1/readiness');
  });

  maybe('marks a card read without deleting or rewriting any stored message', async () => {
    const before = await inApp();
    const { sections } = await feed.feed(userId, 'ORGANIZER');
    const card = sections[0].groups.find((g) => g.summary.startsWith('Balcony'))!;

    // An id that is not the reader's must be ignored, not acted on.
    const stranger = await db.notification.create({
      data: {
        userId: null,
        type: 'EVENT_NOT_SELLABLE',
        channel: 'in_app',
        status: 'SENT',
        toEmail: `stranger+${suffix}@example.test`,
        payload: { eventId: EVENT_ID },
      },
    });
    try {
      const updated = await feed.markManyRead(userId, [...card.unreadIds, stranger.id]);
      expect(updated).toBe(card.unreadIds.length);
      const strangerAfter = await db.notification.findUnique({ where: { id: stranger.id } });
      expect(strangerAfter.readAt).toBeNull();
    } finally {
      await db.notification.delete({ where: { id: stranger.id } });
    }

    const after = await inApp();
    expect(after).toHaveLength(before.length);
    for (const row of before) {
      const same = after.find((r: { id: string }) => r.id === row.id);
      expect(same.payload).toEqual(row.payload);
      expect(same.createdAt).toEqual(row.createdAt);
    }

    // Read, but the problem stands: still listed under Action required, and not dismissible.
    const reread = await feed.feed(userId, 'ORGANIZER');
    const again = reread.sections[0].groups.find((g) => g.summary.startsWith('Balcony'))!;
    expect(reread.sections[0].category).toBe('ACTION_REQUIRED');
    expect(again.read).toBe(true);
    expect(again.dismissible).toBe(false);
  });

  maybe('shows a cause as fixed once the live check stops finding it', async () => {
    current = verdict([RECLINER]);
    const { sections } = await feed.feed(userId, 'ORGANIZER');
    const balcony = sections[0].groups.find((g) => g.summary.startsWith('Balcony'))!;
    const recliner = sections[0].groups.find((g) => g.summary.startsWith('Recliner'))!;
    expect(balcony.resolved).toBe(true);
    expect(balcony.dismissible).toBe(true);
    expect(recliner.resolved).toBe(false);
  });
});
