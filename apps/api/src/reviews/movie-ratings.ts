import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

export interface MovieRating {
  /** 1.0–5.0, one decimal. */
  average: number;
  /** How many people rated — the "votes". */
  count: number;
}

/**
 * Each film's rating, for as many films as a page shows, in one query.
 *
 * ── ONE VOICE PER PERSON ───────────────────────────────────────────────────────────
 * A film is sold as one listing per cinema, and a review belongs to a listing. Someone who saw
 * the film twice, in two cinemas, could therefore hold two reviews of it, and a plain average
 * would count their opinion twice — the easiest way there is to move a film's score. So only
 * each person's LATEST rating of the film counts, whichever cinema it went through. New ratings
 * already update the earlier one (see `ReviewsService.create`); this also holds for any pair
 * written before that rule, or by two requests racing.
 *
 * Films nobody has rated are simply absent from the map.
 */
export async function movieRatingsFor(
  prisma: PrismaService,
  movieIds: readonly string[],
): Promise<Map<string, MovieRating>> {
  if (movieIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<
    { movieId: string; average: number | string; count: number | bigint }[]
  >`
    SELECT latest."movieId" AS "movieId",
           AVG(latest."rating")::float AS average,
           COUNT(*)::int AS count
    FROM (
      SELECT DISTINCT ON (e."movieId", r."userId") e."movieId", r."rating"
      FROM "Review" r
      JOIN "Event" e ON e."id" = r."eventId"
      WHERE e."movieId" IN (${Prisma.join([...movieIds])})
      ORDER BY e."movieId", r."userId", r."updatedAt" DESC
    ) latest
    GROUP BY latest."movieId"
  `;
  return new Map(
    rows.map((row) => [
      row.movieId,
      { average: Math.round(Number(row.average) * 10) / 10, count: Number(row.count) },
    ]),
  );
}
