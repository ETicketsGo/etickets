import { HttpStatus, Injectable } from '@nestjs/common';
import { EventStatus, ExperienceType, MovieStatus, SessionStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { availableUnits } from '../inventory/inventory-strategy.interface';

/**
 * Public, unauthenticated read surface for cinema.
 *
 * WHY THIS EXISTS. A movie's catalogue slug ("skyfront-protocol") and its bookable
 * listing's slug ("skyfront-protocol-show-598484") are different objects, and nothing
 * public connected them: `/movies/:id/shows` is organizer-scoped (403 TENANT_FORBIDDEN
 * for a customer) and `/public/events` deliberately excludes MOVIE. A customer could
 * therefore see a poster and had no route to a showtime. This is the missing hop.
 *
 * WHAT IS DELIBERATELY NOT HERE. Everything organizer- or tenant-private: the owning
 * organizationId, MovieStatus, EventStatus, review notes, fee mode, internal pricing
 * rules, per-ticket-type inventory counts, and anything at all about unpublished or
 * draft records. The DTOs below are the entire contract; new Prisma columns do not leak
 * into them by accident because every field is written out by hand.
 *
 * TIME ZONES. Sessions are returned as ISO instants (`startsAt`), and there is NO
 * venue-local date on the response. That is not an oversight: neither Venue nor Cinema
 * carries a timezone, so a "local date" computed here would be the SERVER's guess. A
 * wrong showtime date is worse than one the client groups in the viewer's own zone,
 * which is what the mobile app does. Adding `Venue.timezone` is the fix, and until it
 * exists this API does not pretend to know.
 */

/** Public catalogue view of a film. Organization and status are never included. */
export interface PublicMovieDto {
  id: string;
  title: string;
  slug: string;
  synopsis: string | null;
  runtimeMinutes: number;
  certificate: string | null;
  language: string;
  genres: string[];
  releaseDate: string | null;
  posterUrl: string | null;
  trailerUrl: string | null;
  cast: string[];
  director: string | null;
}

/** Coarse availability. Exact remaining counts stay server-side. */
export type ShowAvailability = 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT';

export type SeatingType = 'RESERVED' | 'GENERAL_ADMISSION';

/**
 * One bookable screening.
 *
 * `eventSlug` and `sessionId` together are what the client needs to continue into the
 * existing flow: /public/events/:eventSlug for the session's ticket types, and
 * /public/shows/:sessionId/seats for a reserved-seating map.
 */
export interface PublicShowDto {
  sessionId: string;
  eventId: string;
  eventSlug: string;
  startsAt: string;
  endsAt: string;
  venue: { id: string; name: string; city: string; country: string };
  /** Null when the screening is not attached to a cinema screen. */
  cinema: { id: string; name: string; brand: string | null } | null;
  screen: { id: string; name: string } | null;
  /**
   * Presentation format, from the screen (2D / 3D / IMAX / 4DX). Null for a screening
   * with no screen attached — a film shown in a general-admission hall, for instance.
   */
  format: string | null;
  /**
   * Language of the screening.
   *
   * Read from the FILM, because that is where the model holds it. Real cinemas run
   * dubbed and subtitled versions of one film as separate shows; this schema cannot
   * express that, so every show of a film reports the same language. Grouping by
   * language is therefore supported by the contract and will yield one group until
   * `EventSession.language` exists.
   */
  language: string;
  currency: string;
  /** Cheapest ticket for this screening, in minor units. Null when nothing is on sale. */
  fromPriceMinor: number | null;
  seatingType: SeatingType;
  availability: ShowAvailability;
  /** Remaining seats. Null when the screening is not seat-based. */
  seatsAvailable: number | null;
  seatsTotal: number | null;
}

export interface PublicShowsResponse {
  movie: PublicMovieDto;
  shows: PublicShowDto[];
  /**
   * The distinct values present in `shows`, so a client can build date/city/format
   * filter controls without scanning and de-duplicating the list itself.
   */
  filters: {
    dates: string[];
    cities: string[];
    formats: string[];
    languages: string[];
  };
  meta: { total: number; returned: number; limit: number };
}

export interface PublicShowFilters {
  city?: string;
  /** Inclusive lower bound, as an instant. */
  from?: Date;
  /** Exclusive upper bound, as an instant. */
  to?: Date;
  limit: number;
}

/** Below this many remaining seats a screening is reported as LIMITED rather than AVAILABLE. */
const LIMITED_THRESHOLD = 15;

/**
 * Hard ceiling on rows returned, independent of the requested limit.
 *
 * A popular film across a chain can have hundreds of screenings a week, and each row
 * costs a seat-count aggregate. Bounding this keeps one unauthenticated request from
 * becoming an expensive scan.
 */
const MAX_LIMIT = 200;

@Injectable()
export class PublicMoviesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Catalogue metadata for a published film. */
  async getBySlug(slug: string): Promise<PublicMovieDto> {
    const movie = await this.prisma.movie.findUnique({ where: { slug } });

    // A DRAFT or ARCHIVED film is indistinguishable from a nonexistent one to the
    // public — reporting "exists but unpublished" would leak the catalogue pipeline.
    if (!movie || movie.status !== MovieStatus.PUBLISHED) {
      throw new AppException(
        ErrorCodes.MOVIE_NOT_PUBLISHED,
        'Movie not found or not available.',
        HttpStatus.NOT_FOUND,
      );
    }

    return toPublicMovie(movie);
  }

  /**
   * Bookable screenings of a film.
   *
   * Only rows that a customer could actually buy: the film PUBLISHED, its listing
   * Event PUBLISHED, the session SCHEDULED, and the start time still in the future.
   * A film with no such rows returns an empty list rather than a 404 — the film exists
   * and is worth a page; it simply has nothing on.
   */
  async showsBySlug(slug: string, filters: PublicShowFilters): Promise<PublicShowsResponse> {
    const movie = await this.getBySlug(slug);

    const limit = Math.min(Math.max(1, filters.limit), MAX_LIMIT);
    // `now` is captured once so the count and the page cannot disagree about which
    // screenings are still in the future.
    const now = new Date();
    const from = filters.from && filters.from > now ? filters.from : now;

    const where = {
      status: SessionStatus.SCHEDULED,
      startsAt: { gte: from, ...(filters.to ? { lt: filters.to } : {}) },
      event: {
        movieId: movie.id,
        experienceType: ExperienceType.MOVIE,
        status: EventStatus.PUBLISHED,
        ...(filters.city
          ? { venue: { city: { equals: filters.city, mode: 'insensitive' as const } } }
          : {}),
      },
    };

    const [total, sessions] = await this.prisma.$transaction([
      this.prisma.eventSession.count({ where }),
      this.prisma.eventSession.findMany({
        where,
        orderBy: [{ startsAt: 'asc' }],
        take: limit,
        include: {
          event: { include: { venue: true } },
          screen: { include: { cinema: true } },
          ticketTypes: {
            where: { status: 'ACTIVE' },
            orderBy: { priceMinor: 'asc' },
            include: { inventory: true },
          },
        },
      }),
    ]);

    /**
     * Seat availability for the reserved-seating screenings, in ONE grouped query
     * rather than per row. With a screen-full of ShowSeat rows per session, doing this
     * inside the map would be a query per screening on an unauthenticated endpoint.
     */
    const seatSessionIds = sessions.filter((s) => s.screenId).map((s) => s.id);
    const seatCounts = seatSessionIds.length
      ? await this.prisma.showSeat.groupBy({
          by: ['eventSessionId', 'status'],
          where: { eventSessionId: { in: seatSessionIds } },
          _count: { _all: true },
        })
      : [];

    const availableBySession = new Map<string, number>();
    const totalBySession = new Map<string, number>();
    for (const row of seatCounts) {
      const count = row._count._all;
      totalBySession.set(row.eventSessionId, (totalBySession.get(row.eventSessionId) ?? 0) + count);
      if (row.status === 'AVAILABLE') {
        availableBySession.set(
          row.eventSessionId,
          (availableBySession.get(row.eventSessionId) ?? 0) + count,
        );
      }
    }

    const shows: PublicShowDto[] = sessions.map((session) => {
      const reserved = Boolean(session.screenId);
      const cheapest = session.ticketTypes[0] ?? null;

      const seatsAvailable = reserved ? (availableBySession.get(session.id) ?? 0) : null;
      const seatsTotal = reserved ? (totalBySession.get(session.id) ?? 0) : null;

      // General admission has no seat rows; remaining capacity is the sum of what the
      // ticket types still hold.
      const gaRemaining = reserved
        ? null
        : session.ticketTypes.reduce(
            (sum, t) =>
              sum +
              (t.inventory
                ? availableUnits(
                    t.inventory.quantityTotal,
                    t.inventory.quantitySold,
                    t.inventory.quantityHeld,
                  )
                : 0),
            0,
          );

      const remaining = reserved ? (seatsAvailable ?? 0) : (gaRemaining ?? 0);

      return {
        sessionId: session.id,
        eventId: session.event.id,
        eventSlug: session.event.slug,
        startsAt: session.startsAt.toISOString(),
        endsAt: session.endsAt.toISOString(),
        venue: {
          id: session.event.venue.id,
          name: session.event.venue.name,
          city: session.event.venue.city,
          country: session.event.venue.country,
        },
        cinema: session.screen?.cinema
          ? {
              id: session.screen.cinema.id,
              name: session.screen.cinema.name,
              brand: session.screen.cinema.brand,
            }
          : null,
        screen: session.screen ? { id: session.screen.id, name: session.screen.name } : null,
        format: session.screen?.screenType ?? null,
        language: movie.language,
        currency: cheapest?.currency ?? 'INR',
        fromPriceMinor: cheapest?.priceMinor ?? null,
        seatingType: reserved ? 'RESERVED' : 'GENERAL_ADMISSION',
        availability: describeAvailability(remaining, Boolean(cheapest)),
        seatsAvailable,
        seatsTotal,
      };
    });

    return {
      movie,
      shows,
      filters: {
        // ISO date portion of the instant, in UTC. Documented as such: without a venue
        // timezone the server cannot produce a local calendar date, and the client
        // groups by the viewer's zone instead.
        dates: unique(shows.map((s) => s.startsAt.slice(0, 10))),
        cities: unique(shows.map((s) => s.venue.city)),
        formats: unique(shows.map((s) => s.format).filter((f): f is string => Boolean(f))),
        languages: unique(shows.map((s) => s.language)),
      },
      meta: { total, returned: shows.length, limit },
    };
  }
}

function describeAvailability(remaining: number, hasTicketTypes: boolean): ShowAvailability {
  // Nothing on sale is sold out from the customer's point of view, whatever the reason.
  if (!hasTicketTypes || remaining <= 0) return 'SOLD_OUT';
  return remaining <= LIMITED_THRESHOLD ? 'LIMITED' : 'AVAILABLE';
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Explicit projection. Nothing reaches the public response that is not named here. */
function toPublicMovie(movie: {
  id: string;
  title: string;
  slug: string;
  synopsis: string | null;
  runtimeMinutes: number;
  certificate: string | null;
  language: string;
  genres: string[];
  releaseDate: Date | null;
  posterUrl: string | null;
  trailerUrl: string | null;
  cast: string[];
  director: string | null;
}): PublicMovieDto {
  return {
    id: movie.id,
    title: movie.title,
    slug: movie.slug,
    synopsis: movie.synopsis,
    runtimeMinutes: movie.runtimeMinutes,
    certificate: movie.certificate,
    language: movie.language,
    genres: movie.genres,
    releaseDate: movie.releaseDate ? movie.releaseDate.toISOString() : null,
    posterUrl: movie.posterUrl,
    trailerUrl: movie.trailerUrl,
    cast: movie.cast,
    director: movie.director,
  };
}
