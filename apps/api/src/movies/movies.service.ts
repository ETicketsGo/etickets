import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ExperienceType, MovieStatus, Role } from '@eticketsgo/shared-types';
import type { CreateMovieInput, UpdateMovieInput } from '@eticketsgo/validation';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/** Deterministic-ish unique slug from a title, mirroring EventsService. */
export function slugify(title: string): string {
  return `${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}-${randomBytes(3).toString('hex')}`;
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
  constructor(private readonly prisma: PrismaService) {}

  /** PUBLISHED movies as browse cards. */
  async list(filters: PublicMovieFilters) {
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
          where: { experienceType: ExperienceType.MOVIE },
          include: {
            sessions: {
              orderBy: { startsAt: 'asc' },
              include: {
                screen: { include: { cinema: { select: { name: true } } } },
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
      shows: movie.events.map((e) => ({
        eventId: e.id,
        slug: e.slug,
        cinemaName: e.sessions.find((s) => s.screen)?.screen?.cinema.name ?? null,
        sessions: e.sessions.map((s) => ({
          id: s.id,
          startsAt: s.startsAt,
          screenName: s.screen?.name ?? null,
        })),
      })),
    };
  }
}
