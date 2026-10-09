import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { DiscoveryService } from './discovery.service';
import { PublicEventsService } from '../events/public-events.service';
import { EventImageService } from '../events/event-image.service';
import { AdvertisedPriceService } from '../pricing/advertised-price.service';
import { ObjectStoreService } from '../storage/object-store.service';
import { PostgresObjectStore } from '../storage/postgres-object-store';

/**
 * integration-real-postgres - the endpoints the native app reads carry the event's picture.
 *
 * The app reads three: `/public/discovery` (Home's shelves), `/public/events` (search) and
 * `/public/events/:slug` (the event page). It showed no event pictures because its own schemas
 * dropped the fields; this pins the other half of that contract, that the API sends them on
 * all three, from a real upload in a real database, in the shape the app now parses: a path
 * to the original and a path per copy, each a path on this API and not a full URL.
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

const ORGANIZER = { id: 'itest-mobile-img', email: 'm@t.test', fullName: 'M', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;

describe('integration-real-postgres: event pictures on the endpoints the app reads', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;

  const suffix = `mobimg-${Date.now()}`;
  // A city no other suite or seed uses, so discovery scoped to it returns only this event.
  const CITY = `Picturetown ${suffix}`;
  let orgId = '';
  let eventId = '';
  let slug = '';
  let bareSlug = '';

  let events: PublicEventsService;
  let discovery: DiscoveryService;

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

    const org = await db!.organization.create({
      data: { name: `Mobile ${suffix}`, slug: `mobile-${suffix}` },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `Hall ${suffix}`, city: CITY, country: 'India' },
    });
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
    const makeEvent = async (label: string) => {
      const e = await db!.event.create({
        data: {
          organizationId: orgId,
          venueId: venue.id,
          title: `${label} ${suffix}`,
          slug: `${label.toLowerCase()}-${suffix}`,
          category: 'Music',
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });
      const s = await db!.eventSession.create({
        data: { eventId: e.id, startsAt, endsAt: new Date(startsAt.getTime() + 7_200_000) },
      });
      await db!.ticketType.create({
        data: { eventSessionId: s.id, name: 'General', priceMinor: 50_000, quantityTotal: 100 },
      });
      return e;
    };
    const pictured = await makeEvent('Pictured');
    eventId = pictured.id;
    slug = pictured.slug;
    bareSlug = (await makeEvent('Bare')).slug;

    const images = new EventImageService(
      db as never,
      allowAll,
      noAudit,
      new ObjectStoreService(new PostgresObjectStore(db as never)),
    );
    const photo = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 20, g: 90, b: 160 } },
    })
      .jpeg()
      .toBuffer();
    await images.add(ORGANIZER, eventId, {
      buffer: photo,
      size: photo.length,
      mimetype: 'image/jpeg',
    });

    const advertised = new AdvertisedPriceService(
      { feeRule: { findMany: async () => [] } } as never,
      { get: () => undefined } as never,
    );
    events = new PublicEventsService(db as never, advertised);
    discovery = new DiscoveryService(
      db as never,
      { list: async () => [] } as never,
      events,
      { rankExperiences: async (_u: string | null, items: unknown[]) => items } as never,
      { getOrSet: (_k: string, _t: number, produce: () => Promise<unknown>) => produce() } as never,
    );
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    // Sessions, ticket types, images and their copies cascade with the event.
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

  /** What the app parses: a path for the original, and a path for each copy it shows. */
  const expectPicture = (card: { imagePath?: unknown; imageVariants?: unknown }) => {
    expect(card.imagePath).toMatch(new RegExp(`^/public/events/${eventId}/images/`));
    const variants = card.imageVariants as Record<string, string>;
    for (const name of ['card', 'card-sm', 'banner', 'banner-sm', 'thumb']) {
      expect(variants[name]).toMatch(
        new RegExp(`^/public/events/${eventId}/images/[^/]+/${name}\\?v=[0-9a-f]+$`),
      );
    }
  };

  maybe('Home shelves carry the picture, and null for an event without one', async () => {
    const home = (await discovery.get({ city: CITY })) as {
      trendingEvents: { slug: string; imagePath: unknown; imageVariants: unknown }[];
    };
    const pictured = home.trendingEvents.find((e) => e.slug === slug);
    const bare = home.trendingEvents.find((e) => e.slug === bareSlug);
    expectPicture(pictured!);
    expect(bare!.imagePath).toBeNull();
    expect(bare!.imageVariants).toBeNull();
  });

  maybe('search results carry the picture', async () => {
    const page = await events.list({ city: CITY, page: 1, pageSize: 20 });
    expectPicture(page.data.find((e) => e.slug === slug)!);
  });

  maybe('the event page carries the picture', async () => {
    expectPicture(await events.getBySlug(slug));
  });
});
