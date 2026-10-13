import { PublicMoviesService } from './movies.service';

const cache = {
  getOrSet: jest.fn((_k: string, _t: number, producer: () => Promise<unknown>) => producer()),
} as never;

const film = (id: string, organizationId: string) => ({
  id,
  organizationId,
  title: id,
  slug: id,
  posterUrl: null,
  certificate: null,
  language: 'English',
  genres: [],
  runtimeMinutes: 100,
});

function makeService() {
  const prisma = {
    movie: {
      findMany: jest.fn().mockResolvedValue([film('t1', 'org-test'), film('d1', 'org-demo')]),
    },
    review: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
    movieReview: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as never;
  return new PublicMoviesService(prisma, cache, { forTicket: async (x: unknown) => x } as never);
}

describe('public film catalogue content labels', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('labels films and puts DEMO before TEST, dropping none', async () => {
    process.env.APP_ENV = 'QA';
    process.env.DEMO_ORGANIZATION_IDS = 'org-demo';
    const cards = await makeService().list({});
    expect(cards.map((c) => [c.id, c.contentLabel])).toEqual([
      ['d1', 'DEMO'],
      ['t1', 'TEST'],
    ]);
  });

  it('is null and unreordered in PRODUCTION', async () => {
    process.env.APP_ENV = 'PRODUCTION';
    process.env.DEMO_ORGANIZATION_IDS = 'org-demo';
    const cards = await makeService().list({});
    expect(cards.map((c) => [c.id, c.contentLabel])).toEqual([
      ['t1', null],
      ['d1', null],
    ]);
  });
});
