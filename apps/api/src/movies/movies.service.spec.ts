import { MovieStatus } from '@eticketsgo/shared-types';
import { MoviesService, slugify } from './movies.service';

describe('slugify', () => {
  it('lowercases, hyphenates, and appends a random suffix', () => {
    const slug = slugify('Dune: Part Two!');
    expect(slug).toMatch(/^dune-part-two-[0-9a-f]{6}$/);
  });

  it('produces distinct slugs for the same title (unique)', () => {
    const a = slugify('The Same Title');
    const b = slugify('The Same Title');
    expect(a).not.toBe(b);
    expect(a.startsWith('the-same-title-')).toBe(true);
    expect(b.startsWith('the-same-title-')).toBe(true);
  });

  it('trims leading/trailing separators from punctuation-only edges', () => {
    expect(slugify('  ¡Hola! ')).toMatch(/^hola-[0-9a-f]{6}$/);
  });
});

describe('MoviesService.setStatus', () => {
  function makeService(movie: { id: string; organizationId: string } | null) {
    const prisma = {
      movie: {
        findUnique: jest.fn().mockResolvedValue(movie),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: { status: MovieStatus } }) =>
            Promise.resolve({ ...movie, status: data.status }),
          ),
      },
    };
    const access = { assertMember: jest.fn().mockResolvedValue(undefined) };
    const service = new MoviesService(prisma as never, access as never);
    return { service, prisma, access };
  }

  const user = { id: 'u1', email: 'o@x.test', fullName: 'Owner', roles: [] as never };

  it('authorizes the org and transitions the movie to the target status', async () => {
    const { service, prisma, access } = makeService({ id: 'm1', organizationId: 'org1' });

    const result = await service.setStatus(user, 'm1', MovieStatus.PUBLISHED);

    expect(access.assertMember).toHaveBeenCalledWith(user, 'org1', expect.any(Array));
    expect(prisma.movie.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { status: MovieStatus.PUBLISHED },
    });
    expect(result.status).toBe(MovieStatus.PUBLISHED);
  });

  it('throws NOT_FOUND when the movie does not exist', async () => {
    const { service, prisma } = makeService(null);
    await expect(service.setStatus(user, 'missing', MovieStatus.ARCHIVED)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prisma.movie.update).not.toHaveBeenCalled();
  });
});
