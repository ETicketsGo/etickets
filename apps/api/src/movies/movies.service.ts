import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  EventStatus,
  ExperienceType,
  MovieStatus,
  Role,
  SessionStatus,
} from '@eticketsgo/shared-types';
import type { CreateMovieInput, UpdateMovieInput } from '@eticketsgo/validation';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { CacheService } from '../cache/cache.service';
import { AppException, ErrorCodes } from '../common/errors';
import { availableUnits } from '../inventory/inventory-strategy.interface';
import type { RequestUser } from '../common/decorators';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/** Short TTL: the public catalogue is anonymous and safe to serve slightly stale. */
const CATALOG_CACHE_TTL_SECONDS = 60;

/** Deterministic-ish unique slug from a title, mirroring EventsService. */
export function slugify(title: string): string {
  return `${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}-${randomBytes(3).toString('hex')}`;
}

/** Below this many seats remaining, a screening reports LIMITED rather than AVAILABLE. */
const LIMITED_THRESHOLD = 15;

/**
 * Hard ceiling on screenings returned, independent of the requested limit. A popular
 * film across a chain can have hundreds a week and each row costs a seat aggregate;
 * bounding it stops one unauthenticated request becoming an expensive scan.
 */
const MAX_SHOWS = 200;

/**
 * Customer-facing bookability.
 *
 * SALES_PAUSED was added alongside the original three rather than as a separate flag, so a
 * client keeps reading one field to decide whether to show a Book button. A paused show
 * stays in the listing: one that simply vanished looks like a bug to someone who was about
 * to book it, and "sales are paused" is information they can act on.
 */
export type ShowAvailability = 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'SALES_PAUSED';
export type SeatingType = 'RESERVED' | 'GENERAL_ADMISSION';

export interface PublicShowDto {
  sessionId: string;
  eventId: string;
  eventSlug: string;
  startsAt: string;
  endsAt: string;
  venue: { id: string; name: string; city: string; country: string };
  cinema: { id: string; name: string; brand: string | null } | null;
  screen: { id: string; name: string } | null;
  /** Presentation format from the screen (2D / 3D / IMAX / 4DX). */
  format: string | null;
  /**
   * Language of the screening, read from the FILM because that is where the model holds
   * it. Real cinemas run dubbed and subtitled versions as separate shows; this schema
   * cannot express that, so every screening of a film reports the same language.
   * Grouping by language is supported by the contract and yields one group until
   * EventSession.language exists.
   */
  language: string;
  currency: string;
  fromPriceMinor: number | null;
  seatingType: SeatingType;
  availability: ShowAvailability;
  seatsAvailable: number | null;
  seatsTotal: number | null;
}

export interface PublicShowFilters {
  city?: string;
  from?: Date;
  to?: Date;
  limit: number;
}

@Injectable()
export class MoviesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
  ) {}

  private async loadOwnedMovie(user: RequestUser, id: string, roles = ORGANIZER_ROLES) {
    const movie = await this.prisma.movie.findUnique({ where: { id } });
    if (!movie)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Movie not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, movie.organizationId, roles);
    return movie;
  }

  async create(user: RequestUser, organizationId: string, input: CreateMovieInput) {
    await this.access.assertMember(user, organizationId, ORGANIZER_ROLES);
    return this.prisma.movie.create({
      data: {
        organizationId,
        title: input.title,
        slug: slugify(input.title),
        synopsis: input.synopsis,
        runtimeMinutes: input.runtimeMinutes,
        certificate: input.certificate,
        language: input.language,
        genres: input.genres,
        releaseDate: input.releaseDate,
        posterUrl: input.posterUrl,
        trailerUrl: input.trailerUrl,
        cast: input.cast,
        director: input.director,
        status: MovieStatus.DRAFT,
      },
    });
  }

  async update(user: RequestUser, id: string, patch: UpdateMovieInput) {
    await this.loadOwnedMovie(user, id);
    return this.prisma.movie.update({ where: { id }, data: patch });
  }

  async setStatus(user: RequestUser, id: string, status: MovieStatus) {
    await this.loadOwnedMovie(user, id);
    return this.prisma.movie.update({ where: { id }, data: { status } });
  }

  async listForOrg(user: RequestUser, organizationId: string) {
    await this.access.assertMember(user, organizationId);
    return this.prisma.movie.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getForOrg(user: RequestUser, id: string) {
    return this.loadOwnedMovie(user, id, undefined);
  }

  // ─── Admin (across all organizations) ───

  async adminList(
    status: MovieStatus | undefined,
    q: string | undefined,
    page: number,
    pageSize: number,
  ) {
    const where: Prisma.MovieWhereInput = {
      ...(status ? { status } : {}),
      ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.movie.count({ where }),
      this.prisma.movie.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { organization: { select: { name: true } } },
      }),
    ]);
    return {
      data: rows.map((m) => ({
        id: m.id,
        title: m.title,
        slug: m.slug,
        language: m.language,
        certificate: m.certificate,
        status: m.status,
        organizationName: m.organization.name,
        createdAt: m.createdAt,
      })),
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }
}

export interface PublicMovieFilters {
  city?: string;
  genre?: string;
  q?: string;
}

@Injectable()
export class PublicMoviesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /** PUBLISHED movies as browse cards. */
  async list(filters: PublicMovieFilters) {
    // Filters are part of the anonymous cache key so distinct browse queries
    // (city/genre/text) never collide. Raw values keep case-sensitive matching
    // correct.
    const key = `catalog:movies:${filters.city ?? 'all'}:${filters.genre ?? 'all'}:${filters.q ?? 'all'}`;
    return this.cache.getOrSet(key, CATALOG_CACHE_TTL_SECONDS, () => this.query(filters));
  }

  private async query(filters: PublicMovieFilters) {
    const where: Prisma.MovieWhereInput = {
      status: MovieStatus.PUBLISHED,
      ...(filters.q ? { title: { contains: filters.q, mode: 'insensitive' } } : {}),
      ...(filters.genre ? { genres: { has: filters.genre } } : {}),
      // A movie is discoverable in a city when it has a movie-experience show
      // playing at a venue in that city.
      ...(filters.city
        ? {
            events: {
              some: {
                experienceType: ExperienceType.MOVIE,
                venue: { city: { equals: filters.city, mode: 'insensitive' } },
              },
            },
          }
        : {}),
    };
    const movies = await this.prisma.movie.findMany({
      where,
      orderBy: { releaseDate: 'desc' },
      take: 60,
    });
    return movies.map((m) => ({
      id: m.id,
      title: m.title,
      slug: m.slug,
      posterUrl: m.posterUrl,
      certificate: m.certificate,
      language: m.language,
      genres: m.genres,
      runtimeMinutes: m.runtimeMinutes,
    }));
  }

  /** PUBLISHED movie detail with its bookable movie shows (empty until PR-3). */
  async getBySlug(slug: string) {
    const movie = await this.prisma.movie.findUnique({
      where: { slug },
      include: {
        events: {
          where: { experienceType: ExperienceType.MOVIE, status: EventStatus.PUBLISHED },
          include: {
            sessions: {
              where: { startsAt: { gt: new Date() }, screenId: { not: null } },
              orderBy: { startsAt: 'asc' },
              include: {
                screen: { include: { cinema: { select: { id: true, name: true } } } },
              },
            },
          },
        },
      },
    });
    if (!movie || movie.status !== MovieStatus.PUBLISHED) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Movie not found or not available.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Group each published movie-event's future sessions by cinema.
    const shows: {
      eventId: string;
      slug: string;
      cinemaName: string | null;
      sessions: { id: string; startsAt: Date; screenName: string | null }[];
    }[] = [];
    for (const event of movie.events) {
      const byCinema = new Map<string, (typeof shows)[number]>();
      for (const session of event.sessions) {
        const cinema = session.screen?.cinema;
        const key = cinema?.id ?? 'unknown';
        let group = byCinema.get(key);
        if (!group) {
          group = {
            eventId: event.id,
            slug: event.slug,
            cinemaName: cinema?.name ?? null,
            sessions: [],
          };
          byCinema.set(key, group);
          shows.push(group);
        }
        group.sessions.push({
          id: session.id,
          startsAt: session.startsAt,
          screenName: session.screen?.name ?? null,
        });
      }
    }

    return {
      id: movie.id,
      title: movie.title,
      slug: movie.slug,
      posterUrl: movie.posterUrl,
      certificate: movie.certificate,
      language: movie.language,
      genres: movie.genres,
      runtimeMinutes: movie.runtimeMinutes,
      synopsis: movie.synopsis,
      trailerUrl: movie.trailerUrl,
      cast: movie.cast,
      director: movie.director,
      releaseDate: movie.releaseDate,
      shows,
    };
  }

  /**
   * Bookable screenings of a published film, with the commercial data a customer needs
   * to choose one.
   *
   * WHY THIS EXISTS ALONGSIDE getBySlug. getBySlug already returns `shows` grouped by
   * cinema, and that was enough to navigate: it carries the bookable event slug and the
   * session ids. What it does not carry is anything about buying — no price, no
   * currency, no sold-out state, no seating type, no format, and no city (only a cinema
   * name). A showtime picker needs all of those, and a client that has to fetch each
   * session separately to find out whether it is sold out is doing N requests to render
   * one screen.
   *
   * getBySlug is deliberately left alone: it is already deployed and consumed, and
   * widening its response would change a live contract for every existing caller.
   *
   * TIME ZONES. Returned as ISO instants with NO venue-local date, because neither Venue
   * nor Cinema carries a timezone — a "local date" computed here would be the server's
   * guess, and a wrong showtime date is worse than one the client groups in the viewer's
   * own zone. Adding Venue.timezone is the fix.
   */
  async shows(slug: string, filters: PublicShowFilters) {
    const movie = await this.prisma.movie.findUnique({ where: { slug } });

    // A DRAFT or ARCHIVED film is indistinguishable from a missing one, so slug-guessing
    // cannot enumerate the unreleased catalogue.
    if (!movie || movie.status !== MovieStatus.PUBLISHED) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Movie not found or not available.',
        HttpStatus.NOT_FOUND,
      );
    }

    const limit = Math.min(Math.max(1, filters.limit), MAX_SHOWS);
    // Captured once so the count and the page cannot disagree about what is still future.
    const now = new Date();
    const from = filters.from && filters.from > now ? filters.from : now;

    const where = {
      // PAUSED is included so the show is still listed, marked unbookable. CANCELLED and
      // COMPLETED stay excluded: those are not upcoming screenings a customer can plan
      // around, and listing them would clutter the grid with things that will not happen.
      status: { in: [SessionStatus.SCHEDULED, SessionStatus.PAUSED] },
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
     * Seat availability in ONE grouped query rather than per row. With a screen-full of
     * ShowSeat rows per session, doing this inside the map would be a query per
     * screening on an unauthenticated endpoint.
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

      // General admission has no seat rows; capacity is what the ticket types still hold.
      const remaining = reserved
        ? (seatsAvailable ?? 0)
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
        seatingType: reserved ? ('RESERVED' as const) : ('GENERAL_ADMISSION' as const),
        // Paused outranks seat counts: a closed show should not advertise seats it will
        // not sell. Otherwise, nothing on sale is sold out from a customer's point of
        // view, whatever the cause.
        availability:
          session.status === SessionStatus.PAUSED
            ? ('SALES_PAUSED' as const)
            : !cheapest || remaining <= 0
              ? ('SOLD_OUT' as const)
              : remaining <= LIMITED_THRESHOLD
                ? ('LIMITED' as const)
                : ('AVAILABLE' as const),
        seatsAvailable,
        seatsTotal,
      };
    });

    return {
      movie: {
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
      },
      shows,
      /**
       * The distinct values present above, so a client can build filter controls without
       * scanning and de-duplicating the list. `dates` is the UTC date portion — see the
       * timezone note on this method.
       */
      filters: {
        dates: unique(shows.map((s) => s.startsAt.slice(0, 10))),
        cities: unique(shows.map((s) => s.venue.city)),
        formats: unique(shows.map((s) => s.format).filter((f): f is string => Boolean(f))),
        languages: unique(shows.map((s) => s.language)),
      },
      meta: { total, returned: shows.length, limit },
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
