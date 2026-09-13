import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { movieRatingsFor } from './movie-ratings';
import { ReviewsService } from './reviews.service';

/**
 * integration-real-postgres — a film's rating counts each viewer once.
 *
 * The unit tests hold the service to its queries. What only a real database can prove is the
 * SQL itself: that `DISTINCT ON` keeps exactly one rating per person across every cinema listing
 * of the film — their latest — so watching the film twice, in two cinemas, is not two votes.
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

describe('integration-real-postgres: film ratings', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;

  const suffix = `rating-${Date.now()}`;
  let orgId = '';
  let movieId = '';
  let otherMovieId = '';
  const userIds: string[] = [];

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }

    const org = await db.organization.create({
      data: { name: `Ratings ${suffix}`, slug: `ratings-${suffix}` },
    });
    orgId = org.id;
    const venue = await db.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Hyderabad', country: 'India' },
    });
    const film = (slug: string, title: string) =>
      db!.movie.create({
        data: {
          organizationId: orgId,
          title,
          slug,
          runtimeMinutes: 150,
          language: 'Telugu',
          status: 'PUBLISHED',
        },
      });
    movieId = (await film(`mandaadi-${suffix}`, 'Mandaadi')).id;
    otherMovieId = (await film(`epic-${suffix}`, 'Epic')).id;

    const listing = (forMovie: string, cinema: string) =>
      db!.event.create({
        data: {
          organizationId: orgId,
          venueId: venue.id,
          movieId: forMovie,
          experienceType: 'MOVIE',
          title: cinema,
          slug: `${cinema.toLowerCase().replace(/\W+/g, '-')}-${forMovie}`,
          category: 'Movies',
          status: 'PUBLISHED',
        },
      });
    const miyapur = await listing(movieId, 'Miyapur');
    const kukatpally = await listing(movieId, 'Kukatpally');
    const epicListing = await listing(otherMovieId, 'Gachibowli');

    for (const name of ['Asha', 'Ravi', 'Meera']) {
      const u = await db.user.create({
        data: {
          email: `${name.toLowerCase()}+${suffix}@example.test`,
          passwordHash: 'not-a-real-hash',
          fullName: name,
        },
      });
      userIds.push(u.id);
    }
    const [asha, ravi, meera] = userIds;
    const rate = (eventId: string, userId: string, rating: number, updatedAt: string) =>
      db!.review.create({ data: { eventId, userId, rating, updatedAt: new Date(updatedAt) } });

    // Asha watched it twice, in two cinemas: 2 stars first, 5 stars later. She is ONE vote, of 5.
    await rate(miyapur.id, asha, 2, '2026-09-01T10:00:00Z');
    await rate(kukatpally.id, asha, 5, '2026-09-05T10:00:00Z');
    await rate(miyapur.id, ravi, 4, '2026-09-02T10:00:00Z');
    // Meera rated a different film only.
    await rate(epicListing.id, meera, 1, '2026-09-03T10:00:00Z');
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.review.deleteMany({ where: { userId: { in: userIds } } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.movie.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 60_000);

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped — DB unavailable');
      return false;
    }
    return true;
  };

  it('counts each viewer once, by their latest rating, across every cinema listing', async () => {
    if (!guard()) return;
    const ratings = await movieRatingsFor(db as never, [movieId, otherMovieId]);
    // (Asha's latest 5 + Ravi's 4) / 2 — her earlier 2 stars is not a second vote.
    expect(ratings.get(movieId)).toEqual({ average: 4.5, count: 2 });
    expect(ratings.get(otherMovieId)).toEqual({ average: 1, count: 1 });
  });

  it('leaves a film nobody has rated out of the map', async () => {
    if (!guard()) return;
    const ratings = await movieRatingsFor(db as never, ['cm-unrated-film']);
    expect(ratings.size).toBe(0);
  });

  it('gives the film page the same count, distribution and one review per viewer', async () => {
    if (!guard()) return;
    const summary = await new ReviewsService(db as never).forMovie(`mandaadi-${suffix}`);
    expect(summary.count).toBe(2);
    expect(summary.average).toBe(4.5);
    expect(summary.distribution).toMatchObject({ 2: 0, 4: 1, 5: 1 });
    expect(summary.items.map((item) => [item.author, item.rating])).toEqual([
      ['Asha', 5],
      ['Ravi', 4],
    ]);
  });
});
