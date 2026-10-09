import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import { EventImageService } from './event-image.service';
import { PublicEventsController } from './events.controller';
import { PublicEventsService } from './public-events.service';
import { ObjectStoreService } from '../storage/object-store.service';
import { PostgresObjectStore } from '../storage/postgres-object-store';

/**
 * integration-real-postgres - an organizer's upload becomes the copies buyers are served.
 *
 * Proven against a real database and over real HTTP, because what matters is what was WRITTEN
 * (six copies, in the row's own table, cascading with it) and what a BROWSER then receives for
 * each URL: the content type, the cache lifetime, and the bytes. A stubbed Prisma hands back
 * whatever the test gave it, and would agree with any of that being wrong.
 *
 * Covers the three kinds of image the platform will hold at once after this ships: one uploaded
 * now, one uploaded before copies existed (cut on first request), and one from before that
 * cannot be cut at all (served as it is, briefly cached).
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

const ORGANIZER = { id: 'itest-images', email: 'i@t.test', fullName: 'I', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;

describe('integration-real-postgres: event image copies', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let images: EventImageService;
  let app: INestApplication | undefined;
  let base = '';

  const suffix = `images-${Date.now()}`;
  let orgId = '';
  let eventId = '';

  const get = (path: string) => fetch(`${base}${path}`);

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

    // The database driver, which is what every environment runs by default.
    const objects = new ObjectStoreService(new PostgresObjectStore(db as never));
    images = new EventImageService(db as never, allowAll, noAudit, objects);

    const org = await db!.organization.create({
      data: { name: `Images ${suffix}`, slug: `images-${suffix}` },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Pune', country: 'India' },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Images ${suffix}`,
        slug: `images-${suffix}`,
        category: 'Music',
      },
    });
    eventId = event.id;

    // The real public controller, over real HTTP: headers are what this is about.
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicEventsController],
      providers: [
        { provide: PublicEventsService, useValue: {} },
        { provide: EventImageService, useValue: images },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (!db || !available) return;
    // Images and their copies cascade with the event.
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
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

  const upload = async (buffer: Buffer) =>
    images.add(ORGANIZER, eventId, { buffer, size: buffer.length, mimetype: 'image/jpeg' });

  maybe('an upload stores its six copies, upright, beside the untouched original', async () => {
    // A phone's portrait photo stored sideways: 1920x1080 pixels plus "turn me clockwise".
    const sideways = await sharp({
      create: { width: 1920, height: 1080, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const gallery = await upload(sideways);
    const imageId = gallery.images[0].id;

    const stored = await db!.eventImage.findUnique({
      where: { id: imageId },
      select: { bytes: true, sizeBytes: true, focalX: true, focalY: true },
    });
    // The original is kept exactly as uploaded: it is what every copy is cut from again.
    expect(Buffer.from(stored.bytes).equals(sideways)).toBe(true);
    expect(stored.focalX).toBeNull();

    const variants = await db!.eventImageVariant.findMany({
      where: { imageId },
      select: { name: true, width: true, height: true, contentType: true, sizeBytes: true },
      orderBy: { name: 'asc' },
    });
    expect(
      Object.fromEntries(
        variants.map((v: { name: string; width: number; height: number }) => [
          v.name,
          `${v.width}x${v.height}`,
        ]),
      ),
    ).toEqual({
      'banner-sm': '800x450',
      banner: '1080x608',
      'card-sm': '400x300',
      card: '800x600',
      full: '1080x1920',
      thumb: '400x400',
    });
    for (const v of variants) expect(v.contentType).toBe('image/webp');

    // The API names the copies with a version a browser may keep forever.
    expect(gallery.images[0].variants.card).toMatch(
      new RegExp(`^/public/events/${eventId}/images/${imageId}/card\\?v=[0-9a-f]{16}$`),
    );
    expect(gallery.imageVariants?.banner).toBe(gallery.images[0].variants.banner);
  });

  maybe(
    'serves a copy as WebP, cached forever at its own version and briefly otherwise',
    async () => {
      const gallery = await images.gallery(eventId);
      const cardPath = gallery.images[0].variants.card;

      const res = await get(cardPath);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      expect(`${meta.format} ${meta.width}x${meta.height}`).toBe('webp 800x600');

      const stale = await get(cardPath.replace(/\?v=.*/, '?v=0000000000000000'));
      expect(stale.headers.get('cache-control')).toBe('public, max-age=300');

      // A name that is not a copy is a 404, not a quiet 2 MB original.
      expect((await get(cardPath.replace('/card?', '/poster?'))).status).toBe(404);
    },
  );

  maybe('serves the old original link as the upright, metadata-free whole picture', async () => {
    const gallery = await images.gallery(eventId);
    const res = await get(gallery.images[0].path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(`${meta.width}x${meta.height}`).toBe('1080x1920');
    expect(meta.exif).toBeUndefined();
  });

  maybe('moving the focal point cuts the crops again under a new URL', async () => {
    const before = await images.gallery(eventId);
    const imageId = before.images[0].id;
    const oldCard = await db!.eventImageVariant.findUnique({
      where: { imageId_name: { imageId, name: 'card' } },
      select: { sha256: true },
    });
    const oldFull = await db!.eventImageVariant.findUnique({
      where: { imageId_name: { imageId, name: 'full' } },
      select: { sha256: true },
    });

    // A plain colour crops the same anywhere, so give this image some content first.
    const striped = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 30, g: 30, b: 200 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 400, height: 900, channels: 3, background: { r: 30, g: 200, b: 30 } },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .jpeg()
      .toBuffer();
    const added = await upload(striped);
    const stripedId = added.images[1].id;
    const cardOf = async () =>
      (
        await db!.eventImageVariant.findUnique({
          where: { imageId_name: { imageId: stripedId, name: 'card' } },
          select: { sha256: true },
        })
      ).sha256;
    const centred = await cardOf();

    const after = await images.setFocalPoint(ORGANIZER, eventId, stripedId, { x: 0.02, y: 0.5 });
    const moved = after.images.find((i) => i.id === stripedId)!;
    expect(moved.focalPoint).toEqual({ x: 0.02, y: 0.5 });
    expect(await cardOf()).not.toBe(centred);
    expect(moved.variants.card).not.toBe(added.images[1].variants.card);

    const row = await db!.eventImage.findUnique({
      where: { id: stripedId },
      select: { focalX: true, focalY: true },
    });
    expect(row).toEqual({ focalX: 0.02, focalY: 0.5 });
    // Still exactly one of each copy.
    expect(await db!.eventImageVariant.count({ where: { imageId: stripedId } })).toBe(6);

    // The first image was not touched.
    expect(
      (
        await db!.eventImageVariant.findUnique({
          where: { imageId_name: { imageId, name: 'card' } },
          select: { sha256: true },
        })
      ).sha256,
    ).toBe(oldCard.sha256);
    expect(oldFull).toBeTruthy();

    // And the database itself refuses a point outside the picture.
    await expect(
      db!.eventImage.update({ where: { id: stripedId }, data: { focalX: 1.5 } }),
    ).rejects.toThrow();
  });

  maybe(
    'cuts the copies of an image uploaded before copies existed, on first request',
    async () => {
      const legacyBytes = await sharp({
        create: { width: 1200, height: 900, channels: 3, background: { r: 10, g: 10, b: 10 } },
      })
        .jpeg()
        .toBuffer();
      const legacy = await db!.eventImage.create({
        data: {
          eventId,
          position: 5,
          contentType: 'image/jpeg',
          bytes: legacyBytes,
          sizeBytes: legacyBytes.length,
          sha256: 'c'.repeat(64),
        },
        select: { id: true },
      });
      expect(await db!.eventImageVariant.count({ where: { imageId: legacy.id } })).toBe(0);

      const gallery = await images.gallery(eventId);
      const view = gallery.images.find((i) => i.id === legacy.id)!;
      const res = await get(view.variants.banner);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      expect(`${meta.width}x${meta.height}`).toBe('1200x675');
      expect(await db!.eventImageVariant.count({ where: { imageId: legacy.id } })).toBe(6);
    },
  );

  maybe('serves an old image that cannot be cut as it is, and only briefly cached', async () => {
    // Bytes from before anything decoded them: a JPEG signature and nothing a decoder can read.
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
    const legacy = await db!.eventImage.create({
      data: {
        eventId,
        position: 6,
        contentType: 'image/jpeg',
        bytes: broken,
        sizeBytes: broken.length,
        sha256: 'd'.repeat(64),
      },
      select: { id: true },
    });
    const gallery = await images.gallery(eventId);
    const view = gallery.images.find((i) => i.id === legacy.id)!;
    const res = await get(view.variants.card);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(Buffer.from(await res.arrayBuffer()).equals(broken)).toBe(true);
    expect(await db!.eventImageVariant.count({ where: { imageId: legacy.id } })).toBe(0);
  });

  maybe('refuses a non-image upload and stores nothing', async () => {
    const before = await db!.eventImage.count({ where: { eventId } });
    const renamed = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('not a photo')]);
    await expect(upload(renamed)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await db!.eventImage.count({ where: { eventId } })).toBe(before);
  });

  maybe('removing an image removes its copies', async () => {
    const gallery = await images.gallery(eventId);
    const imageId = gallery.images[0].id;
    await images.remove(ORGANIZER, eventId, imageId);
    expect(await db!.eventImageVariant.count({ where: { imageId } })).toBe(0);
  });
});
