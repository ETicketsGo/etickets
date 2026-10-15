import sharp from 'sharp';
import { MoviePosterService, moviePosterKey, renderMoviePoster } from './movie-poster.service';

/**
 * A film poster is uploaded, cut to one WebP, written through the object store, and served
 * back by its hash. Real `sharp`, fake store: the store has its own suite.
 */
const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#0d9488' } })
    .png()
    .toBuffer();

function build(opts: { member?: boolean; publicUrl?: string | null } = {}) {
  const store = new Map<string, Buffer>();
  const movie = { id: 'mov1', organizationId: 'org1', posterUrl: null as string | null };
  const audits: unknown[] = [];
  const prisma = {
    movie: {
      findUnique: jest.fn(async () => movie),
      update: jest.fn(async ({ data }: { data: { posterUrl: string } }) => {
        movie.posterUrl = data.posterUrl;
        return { ...movie };
      }),
    },
  };
  const access = {
    assertMember: jest.fn(async () => {
      if (opts.member === false) throw new Error('not a member');
    }),
  };
  const objects = {
    write: jest.fn(async ({ key, body }: { key: string; body: Buffer }) => {
      store.set(key, body);
      return key;
    }),
    read: jest.fn(async (row: { storageKey: string }) => {
      const body = store.get(row.storageKey);
      return body ? { body, contentType: 'image/webp', sizeBytes: body.length } : null;
    }),
    publicUrl: jest.fn(() => opts.publicUrl ?? null),
  };
  const svc = new MoviePosterService(
    prisma as never,
    access as never,
    objects as never,
    { record: async (a: unknown) => void audits.push(a) } as never,
    { get: () => undefined } as never,
  );
  return { svc, store, movie, objects, access, audits };
}

const USER = { id: 'u1' } as never;
const file = (buffer: Buffer) => ({ buffer, size: buffer.length, mimetype: 'image/png' });

describe('MoviePosterService', () => {
  it('stores one WebP under a content key and points posterUrl at the API route', async () => {
    const { svc, store, movie, audits } = build();
    const updated = await svc.upload(USER, 'mov1', file(await png(1200, 1800)), 'https://api.test');
    expect(store.size).toBe(1);
    const [key, bytes] = [...store.entries()][0];
    expect(key).toMatch(/^public\/movies\/mov1\/[0-9a-f]{32}\.webp$/);
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe('webp');
    // Cut down to the poster size, keeping its shape.
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(1200);
    expect(updated.posterUrl).toMatch(
      /^https:\/\/api\.test\/api\/public\/movies\/mov1\/poster\/[0-9a-f]{32}\.webp$/,
    );
    expect(movie.posterUrl).toBe(updated.posterUrl);
    expect(audits).toHaveLength(1);
  });

  it('serves the stored poster back by its file name, and nothing else', async () => {
    const { svc } = build();
    const updated = await svc.upload(USER, 'mov1', file(await png(300, 450)), 'http://h');
    const name = updated.posterUrl!.split('/').pop()!;
    const served = await svc.read('mov1', name);
    expect(served?.contentType).toBe('image/webp');
    expect(served?.bytes?.length).toBeGreaterThan(0);
    expect(await svc.read('mov1', '../../secret.webp')).toBeNull();
    expect(await svc.read('mov1', 'f'.repeat(32) + '.webp')).toBeNull();
    expect(await svc.read('mov1/../x', name)).toBeNull();
  });

  it('redirects to the CDN when the store has a public address', async () => {
    const { svc } = build({ publicUrl: 'https://cdn.test/p.webp' });
    const served = await svc.read('mov1', 'a'.repeat(32) + '.webp');
    expect(served).toMatchObject({ redirectTo: 'https://cdn.test/p.webp' });
  });

  it('refuses a file that is not a picture, whatever it claims to be', async () => {
    const { svc, store } = build();
    await expect(
      svc.upload(USER, 'mov1', file(Buffer.from('<svg onload=alert(1)>')), 'http://h'),
    ).rejects.toMatchObject({ message: expect.stringMatching(/could not be read as an image/) });
    expect(store.size).toBe(0);
  });

  it('refuses an empty upload and a non-member', async () => {
    await expect(build().svc.upload(USER, 'mov1', undefined, 'http://h')).rejects.toMatchObject({
      message: 'Choose an image to upload.',
    });
    const { svc, store } = build({ member: false });
    await expect(svc.upload(USER, 'mov1', file(await png(10, 10)), 'http://h')).rejects.toThrow(
      'not a member',
    );
    expect(store.size).toBe(0);
  });

  it('never enlarges a small poster', async () => {
    const out = await renderMoviePoster(await png(200, 300));
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([200, 300]);
  });

  it('keys are refused for an id that could escape its folder', () => {
    expect(() => moviePosterKey('../x', 'a'.repeat(32))).toThrow();
  });
});
