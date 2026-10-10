import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { EventsService } from './events.service';
import { EventImageService } from './event-image.service';
import { ObjectStoreService } from '../storage/object-store.service';
import { PostgresObjectStore } from '../storage/postgres-object-store';

/**
 * integration-real-postgres - a repeated create makes ONE event, and a repeated upload ONE image.
 *
 * Found as an e2e race on 2026-10-10: the console creates the event and then uploads its
 * images, and a browser can lose the answer to a request that did arrive (a reload, a dropped
 * connection, a double click). The retry carries the same Idempotency-Key, and what is proven
 * here is what the DATABASE holds afterwards - one row, however the repeats arrive, including
 * two at the same moment. A stubbed Prisma would agree with any answer, which is the reason
 * this runs against Postgres and its unique index.
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

const suffix = `idem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const USER = { id: `itest-${suffix}`, email: 'i@t.test', fullName: 'I', roles: [] } as never;
const OTHER_USER = { id: `itest-other-${suffix}`, email: 'o@t.test', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;

describe('integration-real-postgres: one event per create key, one image per upload key', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let events: EventsService;
  let images: EventImageService;
  let orgId = '';
  let venueId = '';
  let jpeg: Buffer;
  let otherJpeg: Buffer;

  const key = (name: string) => `${name}-${suffix}`;
  const body = (title: string) => ({ venueId, title, category: 'Music' }) as never;

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
    images = new EventImageService(
      db as never,
      allowAll,
      noAudit,
      new ObjectStoreService(new PostgresObjectStore(db as never)),
    );
    const org = await db!.organization.create({
      data: { name: `Idem ${suffix}`, slug: `idem-${suffix}` },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Pune', country: 'India' },
    });
    venueId = venue.id;
    const picture = (r: number) =>
      sharp({ create: { width: 64, height: 36, channels: 3, background: { r, g: 90, b: 90 } } })
        .jpeg()
        .toBuffer();
    jpeg = await picture(200);
    otherJpeg = await picture(20);
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    // Images cascade with their events.
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.idempotencyRecord.deleteMany({ where: { key: { endsWith: suffix } } });
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

  const countEvents = (title: string) =>
    db!.event.count({ where: { organizationId: orgId, title } });

  maybe('the same create sent twice makes one event, and both answers name it', async () => {
    const title = `Twice ${suffix}`;
    const first = await events.create(USER, orgId, body(title), key('twice'));
    const second = await events.create(USER, orgId, body(title), key('twice'));
    expect(second.id).toBe(first.id);
    expect(await countEvents(title)).toBe(1);
  });

  maybe('the same create sent twice AT ONCE makes one event', async () => {
    const title = `Race ${suffix}`;
    const answers = await Promise.all(
      [1, 2, 3].map(() => events.create(USER, orgId, body(title), key('race'))),
    );
    expect(new Set(answers.map((event) => event.id)).size).toBe(1);
    expect(await countEvents(title)).toBe(1);
  });

  maybe('a key reused for a different event is refused, not answered with the first', async () => {
    await events.create(USER, orgId, body(`Reused A ${suffix}`), key('reused'));
    await expect(
      events.create(USER, orgId, body(`Reused B ${suffix}`), key('reused')),
    ).rejects.toMatchObject({ status: 409 });
    expect(await countEvents(`Reused B ${suffix}`)).toBe(0);
  });

  maybe("one person's key never returns another person's event", async () => {
    const title = `Mine ${suffix}`;
    const mine = await events.create(USER, orgId, body(title), key('mine'));
    const theirs = await events.create(OTHER_USER, orgId, body(title), key('mine'));
    expect(theirs.id).not.toBe(mine.id);
  });

  maybe('without a key, two creates are two events, exactly as before', async () => {
    const title = `Unkeyed ${suffix}`;
    await events.create(USER, orgId, body(title));
    await events.create(USER, orgId, body(title));
    expect(await countEvents(title)).toBe(2);
  });

  maybe('a retried upload adds the picture once, even when the repeats race', async () => {
    const event = await events.create(USER, orgId, body(`Images ${suffix}`));
    const file = { buffer: jpeg, size: jpeg.length, mimetype: 'image/jpeg' };
    const first = await images.add(USER, event.id, file, key('poster'));
    expect(first.images).toHaveLength(1);
    const again = await images.add(USER, event.id, file, key('poster'));
    expect(again.images.map((image) => image.id)).toEqual(first.images.map((image) => image.id));

    const second = { buffer: otherJpeg, size: otherJpeg.length, mimetype: 'image/jpeg' };
    await Promise.all([1, 2, 3].map(() => images.add(USER, event.id, second, key('stage'))));
    expect(await db!.eventImage.count({ where: { eventId: event.id } })).toBe(2);

    // A different key is a different file the organizer chose: the same picture twice is allowed.
    await images.add(USER, event.id, file, key('poster-again'));
    expect(await db!.eventImage.count({ where: { eventId: event.id } })).toBe(3);
  });

  maybe('a refused upload leaves its key free, so the retry is not answered as done', async () => {
    const event = await events.create(USER, orgId, body(`Refused ${suffix}`));
    const junk = Buffer.from('not an image at all');
    await expect(
      images.add(USER, event.id, { buffer: junk, size: junk.length }, key('refused')),
    ).rejects.toBeDefined();
    const file = { buffer: jpeg, size: jpeg.length, mimetype: 'image/jpeg' };
    const retried = await images.add(USER, event.id, file, key('refused'));
    expect(retried.images).toHaveLength(1);
  });
});
