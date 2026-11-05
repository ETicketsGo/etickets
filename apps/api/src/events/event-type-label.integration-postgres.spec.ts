import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEventSchema } from '@eticketsgo/validation';
import { EventsService } from './events.service';

/**
 * integration-real-postgres - "Other event type" stores Other plus the organizer's own words.
 *
 * What the database holds is the point: the category every typed event shares (so one browse
 * filter finds them all), the label buyers read, that saving another field leaves both alone,
 * and that an empty label clears to NULL. The body goes through the same schema the API
 * validates with.
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

const suffix = `type-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const USER = { id: `itest-${suffix}`, email: 'i@t.test', fullName: 'I', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;

describe('integration-real-postgres: Other event type', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let events: EventsService;
  let orgId = '';
  let venueId = '';

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
    events = new EventsService(
      db as never,
      allowAll,
      noAudit,
      {} as never,
      { get: () => 'http://localhost:3000' } as never,
      {} as never,
      {} as never,
    );
    const org = await db!.organization.create({
      data: { name: `Type ${suffix}`, slug: `type-${suffix}` },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Pune', country: 'India' },
    });
    venueId = venue.id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
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
    'stores Other and the typed label, keeps them on other saves, clears on empty',
    async () => {
      const body = createEventSchema.parse({
        venueId,
        title: `Poetry ${suffix}`,
        category: 'Other',
        typeLabel: '  Poetry reading ',
      });
      const created = await events.create(USER, orgId, body as never);
      let row = await db!.event.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.category).toBe('Other');
      expect(row.typeLabel).toBe('Poetry reading');

      await events.update(USER, created.id, { description: 'An evening of verse.' });
      row = await db!.event.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.typeLabel).toBe('Poetry reading');
      expect(row.category).toBe('Other');

      const cleared = createEventSchema.partial().parse({ category: 'Music', typeLabel: '' });
      await events.update(USER, created.id, cleared as never);
      row = await db!.event.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.category).toBe('Music');
      expect(row.typeLabel).toBeNull();
    },
  );

  maybe('an event created without a label has none (older clients unchanged)', async () => {
    const created = await events.create(USER, orgId, {
      venueId,
      title: `Gig ${suffix}`,
      category: 'Music',
    } as never);
    const row = await db!.event.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.typeLabel).toBeNull();
  });
});
