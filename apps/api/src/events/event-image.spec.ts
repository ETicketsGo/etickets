import { EventStatus } from '@eticketsgo/shared-types';
import { EventImageService } from './event-image.service';
import { EVENT_IMAGE_MAX_BYTES, eventImagePath, sniffImageType } from './event-image';

/**
 * An organizer's image, which the API then serves to every buyer's browser.
 *
 * What matters is what gets STORED: only real raster images, only by people who may edit the
 * event, and only while it is editable. A file is judged by its bytes, never by its name or
 * the content type the upload claims.
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

describe('eventImagePath', () => {
  it('is versioned by the hash, so a replaced image is a new URL', () => {
    const a = eventImagePath('ev1', 'a'.repeat(64));
    const b = eventImagePath('ev1', 'b'.repeat(64));
    expect(a).toBe(`/public/events/ev1/image?v=${'a'.repeat(16)}`);
    expect(a).not.toBe(b);
  });
});

describe('EventImageService', () => {
  const organizer = { id: 'u1', role: 'ORGANIZER_OWNER' } as never;

  function setup(status: string = EventStatus.DRAFT, event: object | null = {}) {
    const prisma = {
      event: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            event ? { id: 'ev1', organizationId: 'org1', status, ...event } : null,
          ),
      },
      eventImage: {
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
    };
    const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new EventImageService(prisma as never, access as never, audit as never);
    return { service, prisma, access, audit };
  }

  it('stores the bytes with the type READ from them, not the type claimed', async () => {
    const { service, prisma } = setup();
    const result = await service.put(organizer, 'ev1', {
      buffer: PNG,
      size: PNG.length,
      mimetype: 'image/jpeg',
    });
    const written = prisma.eventImage.upsert.mock.calls[0][0];
    expect(written.create.contentType).toBe('image/png');
    expect(written.create.sizeBytes).toBe(PNG.length);
    expect(written.create.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.imagePath).toBe(eventImagePath('ev1', written.create.sha256));
  });

  it('refuses an SVG dressed up as a PNG, and stores nothing', async () => {
    const { service, prisma } = setup();
    await expect(
      service.put(organizer, 'ev1', { buffer: SVG, size: SVG.length, mimetype: 'image/png' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(prisma.eventImage.upsert).not.toHaveBeenCalled();
  });

  it('refuses a file over the limit, even if the interceptor was bypassed', async () => {
    const { service, prisma } = setup();
    const big = Buffer.concat([JPEG, Buffer.alloc(EVENT_IMAGE_MAX_BYTES)]);
    await expect(service.put(organizer, 'ev1', { buffer: big, size: big.length })).rejects.toThrow(
      /larger than 2 MB/,
    );
    expect(prisma.eventImage.upsert).not.toHaveBeenCalled();
  });

  it('refuses an upload with no file', async () => {
    const { service } = setup();
    await expect(service.put(organizer, 'ev1', undefined)).rejects.toThrow(/Choose an image/);
  });

  it('checks the caller belongs to the organization, as an owner or manager', async () => {
    const { service, access } = setup();
    await service.put(organizer, 'ev1', { buffer: PNG, size: PNG.length });
    expect(access.assertMember).toHaveBeenCalledWith(organizer, 'org1', [
      'ORGANIZER_OWNER',
      'ORGANIZER_MANAGER',
    ]);
  });

  it('follows the edit rule: a published event is paused before its image changes', async () => {
    const { service, prisma } = setup(EventStatus.PUBLISHED);
    await expect(
      service.put(organizer, 'ev1', { buffer: PNG, size: PNG.length }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.remove(organizer, 'ev1')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prisma.eventImage.upsert).not.toHaveBeenCalled();
    expect(prisma.eventImage.deleteMany).not.toHaveBeenCalled();
  });

  it('404s for an event that does not exist', async () => {
    const { service } = setup(EventStatus.DRAFT, null);
    await expect(
      service.put(organizer, 'nope', { buffer: PNG, size: PNG.length }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reads only the columns the image route needs', async () => {
    const { service, prisma } = setup();
    await service.read('ev1');
    expect(prisma.eventImage.findUnique).toHaveBeenCalledWith({
      where: { eventId: 'ev1' },
      select: { bytes: true, contentType: true, sha256: true },
    });
  });
});
