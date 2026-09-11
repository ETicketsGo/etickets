import { EventStatus } from '@eticketsgo/shared-types';
import { EventImageService } from './event-image.service';
import {
  EVENT_IMAGE_MAX_BYTES,
  EVENT_IMAGE_MAX_COUNT,
  coverImagePath,
  eventImagePath,
  sniffImageType,
} from './event-image';

/**
 * An organizer's images, which the API then serves to every buyer's browser.
 *
 * What matters is what gets STORED: only real raster images, only by people who may edit the
 * event, only while it is still selling, never more than ten — and in the order the organizer
 * chose, because the first one is the cover every listing shows.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');

describe('sniffImageType', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['WebP', WEBP, 'image/webp'],
  ])('recognises %s by its signature', (_name, bytes, type) => {
    expect(sniffImageType(bytes)).toBe(type);
  });

  it.each([
    ['SVG, which can carry script', SVG],
    ['HTML', HTML],
    ['an empty file', Buffer.alloc(0)],
    ['a truncated PNG header', PNG.subarray(0, 4)],
  ])('refuses %s', (_name, bytes) => {
    expect(sniffImageType(bytes)).toBeNull();
  });
});

describe('image paths', () => {
  it('names one image of one event, versioned by its hash', () => {
    const a = eventImagePath('ev1', 'img1', 'a'.repeat(64));
    expect(a).toBe(`/public/events/ev1/images/img1?v=${'a'.repeat(16)}`);
    expect(eventImagePath('ev1', 'img1', 'b'.repeat(64))).not.toBe(a);
  });

  it('calls the first image in order the cover, and has none for no images', () => {
    const rows = [
      { id: 'second', sha256: 'b'.repeat(64) },
      { id: 'first', sha256: 'a'.repeat(64) },
    ];
    expect(coverImagePath('ev1', rows)).toBe(eventImagePath('ev1', 'second', 'b'.repeat(64)));
    expect(coverImagePath('ev1', [])).toBeNull();
  });
});

type Row = {
  id: string;
  eventId: string;
  position: number;
  sha256: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
};

describe('EventImageService', () => {
  const organizer = { id: 'u1', role: 'ORGANIZER_OWNER' } as never;

  /** A small in-memory stand-in for the two tables this service touches. */
  function setup(status: string = EventStatus.DRAFT, seed: Partial<Row>[] = []) {
    let rows: Row[] = seed.map((row, i) => ({
      id: `img${i + 1}`,
      eventId: 'ev1',
      position: i,
      sha256: String(i + 1)
        .repeat(64)
        .slice(0, 64),
      contentType: 'image/jpeg',
      sizeBytes: 10,
      createdAt: new Date(2026, 0, 1, 0, i),
      ...row,
    }));
    let created = 0;
    const ordered = () =>
      [...rows].sort((a, b) => a.position - b.position || +a.createdAt - +b.createdAt);
    const eventImage = {
      findMany: jest.fn(async ({ where }: { where: { eventId: string } }) =>
        ordered().filter((row) => row.eventId === where.eventId),
      ),
      findFirst: jest.fn(
        async ({ where }: { where: { id?: string; eventId: string } }) =>
          ordered().find(
            (row) => row.eventId === where.eventId && (!where.id || row.id === where.id),
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Omit<Row, 'id' | 'createdAt'> }) => {
        const row = { ...data, id: `new${++created}`, createdAt: new Date() } as Row;
        rows.push(row);
        return { id: row.id };
      }),
      deleteMany: jest.fn(async ({ where }: { where: { id: string; eventId: string } }) => {
        const before = rows.length;
        rows = rows.filter((row) => !(row.id === where.id && row.eventId === where.eventId));
        return { count: before - rows.length };
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: { position: number } }) => {
          const row = rows.find((r) => r.id === where.id)!;
          row.position = data.position;
          return row;
        },
      ),
    };
    const prisma = {
      event: {
        findUnique: jest
          .fn()
          .mockResolvedValue(status ? { id: 'ev1', organizationId: 'org1', status } : null),
      },
      eventImage,
      $transaction: jest.fn(async (arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (tx: unknown) => unknown)({ eventImage })
          : Promise.all(arg as Promise<unknown>[]),
      ),
    };
    const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new EventImageService(prisma as never, access as never, audit as never);
    return { service, prisma, access, audit, rows: () => ordered() };
  }

  const png = { buffer: PNG, size: PNG.length, mimetype: 'image/jpeg' };

  it('stores the type READ from the bytes, not the type claimed, and the first is the cover', async () => {
    const { service, prisma } = setup();
    const result = await service.add(organizer, 'ev1', png);
    const written = prisma.eventImage.create.mock.calls[0][0].data;
    expect(written.contentType).toBe('image/png');
    expect(written.position).toBe(0);
    expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.images).toHaveLength(1);
    expect(result.imagePath).toBe(result.images[0].path);
  });

  it('adds after the existing images, whatever gaps removals left', async () => {
    const { service, prisma } = setup(EventStatus.DRAFT, [{ position: 0 }, { position: 4 }]);
    const result = await service.add(organizer, 'ev1', png);
    expect(prisma.eventImage.create.mock.calls[0][0].data.position).toBe(5);
    expect(result.images.map((image) => image.id)).toEqual(['img1', 'img2', 'new1']);
  });

  it(`refuses the ${EVENT_IMAGE_MAX_COUNT + 1}th image`, async () => {
    const { service, prisma } = setup(
      EventStatus.DRAFT,
      Array.from({ length: EVENT_IMAGE_MAX_COUNT }, () => ({})),
    );
    await expect(service.add(organizer, 'ev1', png)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prisma.eventImage.create).not.toHaveBeenCalled();
  });

  it('refuses an SVG dressed up as a PNG, an oversized file and no file, storing nothing', async () => {
    const { service, prisma } = setup();
    await expect(
      service.add(organizer, 'ev1', { buffer: SVG, size: SVG.length, mimetype: 'image/png' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const big = Buffer.concat([JPEG, Buffer.alloc(EVENT_IMAGE_MAX_BYTES)]);
    await expect(service.add(organizer, 'ev1', { buffer: big, size: big.length })).rejects.toThrow(
      /larger than 2 MB/,
    );
    await expect(service.add(organizer, 'ev1', undefined)).rejects.toThrow(/Choose an image/);
    expect(prisma.eventImage.create).not.toHaveBeenCalled();
  });

  it('checks the caller belongs to the organization, as an owner or manager', async () => {
    const { service, access } = setup();
    await service.add(organizer, 'ev1', png);
    expect(access.assertMember).toHaveBeenCalledWith(organizer, 'org1', [
      'ORGANIZER_OWNER',
      'ORGANIZER_MANAGER',
    ]);
  });

  it.each([
    EventStatus.PUBLISHED,
    EventStatus.SOLD_OUT,
    EventStatus.PAUSED,
    EventStatus.UNDER_REVIEW,
  ])('changes images on a %s event without pausing it', async (status) => {
    const { service } = setup(status, [{}]);
    await expect(service.add(organizer, 'ev1', png)).resolves.toMatchObject({
      images: expect.any(Array),
    });
    await expect(service.reorder(organizer, 'ev1', ['new1', 'img1'])).resolves.toBeTruthy();
    await expect(service.remove(organizer, 'ev1', 'img1')).resolves.toBeTruthy();
  });

  it.each([EventStatus.CANCELLED, EventStatus.COMPLETED, EventStatus.ARCHIVED])(
    'locks the images of a %s event',
    async (status) => {
      const { service, prisma } = setup(status, [{}]);
      await expect(service.add(organizer, 'ev1', png)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(service.remove(organizer, 'ev1', 'img1')).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      await expect(service.reorder(organizer, 'ev1', ['img1'])).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(prisma.eventImage.create).not.toHaveBeenCalled();
      expect(prisma.eventImage.deleteMany).not.toHaveBeenCalled();
    },
  );

  it('removes only an image of THIS event, and 404s for anything else', async () => {
    const { service, rows } = setup(EventStatus.DRAFT, [{}, { eventId: 'other-event' }]);
    await expect(service.remove(organizer, 'ev1', 'img2')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(rows()).toHaveLength(2);
    const result = await service.remove(organizer, 'ev1', 'img1');
    expect(result.images).toEqual([]);
    expect(result.imagePath).toBeNull();
  });

  it('reorders the whole list, making the first the cover', async () => {
    const { service } = setup(EventStatus.DRAFT, [{}, {}, {}]);
    const result = await service.reorder(organizer, 'ev1', ['img3', 'img1', 'img2']);
    expect(result.images.map((image) => image.id)).toEqual(['img3', 'img1', 'img2']);
    expect(result.imagePath).toBe(result.images[0].path);
  });

  it.each([
    ['a list missing an image', ['img1', 'img2']],
    ['a duplicated image', ['img1', 'img1', 'img2']],
    ['an image from somewhere else', ['img1', 'img2', 'stranger']],
  ])('refuses %s rather than half-applying it', async (_name, ids) => {
    const { service, prisma } = setup(EventStatus.DRAFT, [{}, {}, {}]);
    await expect(service.reorder(organizer, 'ev1', ids)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(prisma.eventImage.update).not.toHaveBeenCalled();
  });

  it('404s for an event that does not exist', async () => {
    const { service } = setup('');
    await expect(service.add(organizer, 'nope', png)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reads one image only within its own event, and the cover by order', async () => {
    const { service } = setup(EventStatus.DRAFT, [{ position: 1 }, { position: 0 }]);
    await expect(service.read('ev1', 'img1')).resolves.toMatchObject({ id: 'img1' });
    await expect(service.read('other-event', 'img1')).resolves.toBeNull();
    await expect(service.readCover('ev1')).resolves.toMatchObject({ id: 'img2' });
  });
});
