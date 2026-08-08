import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { EventStatus, ExperienceType, Role, SessionStatus } from '@eticketsgo/shared-types';
import type {
  BulkScheduleShowsInput,
  GenerateSeatMapInput,
  ScheduleShowInput,
} from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import { slugify } from '../movies/movies.service';
import type { RequestUser } from '../common/decorators';
import {
  DEFAULT_TURNAROUND_MINUTES,
  datesInRange,
  decideSchedule,
  expandSchedule,
  type ScheduleDecision,
  type ShowWindow,
} from './show-scheduling';
import { AuditService } from '../audit/audit.service';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/**
 * Turn a wall-clock date and time in a named zone into an absolute instant.
 *
 * A theater publishes "10:30", not an offset, and that must stay 10:30 locally whatever the
 * server's zone and whichever side of a DST change the date falls on. Naive
 * `new Date(`${date}T${time}`)` uses the SERVER's zone, so a container in UTC would
 * schedule every Indian show 5h30m late.
 *
 * Derives the zone's offset for that specific instant via Intl rather than assuming a fixed
 * one, so a market that observes DST stays correct across the transition.
 */
export function zonedWallClockToInstant(date: string, time: string, timeZone: string): Date {
  const naive = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(naive);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  // What the zone calls that UTC instant, read back as if it were UTC. The difference is
  // the zone's offset at that moment.
  const asZone = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second'),
  );
  return new Date(naive.getTime() - (asZone - naive.getTime()));
}

/** Flattens scheduling rejections into a stable, client-readable shape. */
function describeRejections(decision: ScheduleDecision) {
  return decision.rejected.map(({ show, rejection }) => {
    const base = { startsAt: show.startsAt, endsAt: show.endsAt, reason: rejection.reason };
    switch (rejection.reason) {
      case 'OVERLAPS_EXISTING_SHOW':
        return { ...base, detail: rejection.conflictsWith, gapMinutes: rejection.gapMinutes };
      case 'OVERLAPS_PROPOSED_SHOW':
        return { ...base, detail: rejection.conflictsWith, gapMinutes: rejection.gapMinutes };
      case 'DUPLICATE_IN_REQUEST':
        return { ...base, detail: rejection.duplicateOf };
      default:
        return base;
    }
  });
}

/** The GET/POST seat-map response shape (categories + sections→rows→seats). */
export interface SeatMapView {
  id: string;
  screenId: string;
  name: string | null;
  categories: { id: string; name: string; colorHex: string | null; basePriceMinor: number }[];
  sections: {
    id: string;
    name: string;
    rows: {
      id: string;
      label: string;
      seats: { id: string; label: string; colIndex: number; seatCategoryId: string }[];
    }[];
  }[];
}

export interface ShowRowView {
  sessionId: string;
  startsAt: Date;
  endsAt: Date;
  screenName: string | null;
  cinemaName: string | null;
  seatsSold: number;
  seatsTotal: number;
}

@Injectable()
export class ShowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    // Optional so existing specs that construct this service with two arguments keep
    // working; both fall back to safe defaults.
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** Minimum gap between two shows on one screen. See SHOW_TURNAROUND_MINUTES. */
  private get turnaroundMinutes(): number {
    const configured = this.config?.get<number>('SHOW_TURNAROUND_MINUTES');
    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_TURNAROUND_MINUTES;
  }

  /** Loads a screen and authorizes the caller via its cinema's organization. */
  private async loadOwnedScreen(user: RequestUser, screenId: string, roles = ORGANIZER_ROLES) {
    const screen = await this.prisma.screen.findUnique({
      where: { id: screenId },
      include: { cinema: true },
    });
    if (!screen)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Screen not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, screen.cinema.organizationId, roles);
    return screen;
  }

  // ─── Seat maps ───

  async generateSeatMap(
    user: RequestUser,
    screenId: string,
    input: GenerateSeatMapInput,
  ): Promise<SeatMapView> {
    await this.loadOwnedScreen(user, screenId);

    const existing = await this.prisma.seatMap.findUnique({ where: { screenId } });
    if (existing) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This screen already has a seat map.',
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const seatMap = await tx.seatMap.create({
        data: { screenId, name: input.name },
      });
      for (const [index, section] of input.sections.entries()) {
        const category = await tx.seatCategory.create({
          data: {
            seatMapId: seatMap.id,
            name: section.categoryName,
            colorHex: section.colorHex,
            basePriceMinor: section.basePriceMinor,
            sortOrder: index,
          },
        });
        const seatSection = await tx.seatSection.create({
          data: { seatMapId: seatMap.id, name: section.name, sortOrder: index },
        });
        for (const [rowIndex, rowLabel] of section.rowLabels.entries()) {
          const row = await tx.seatRow.create({
            data: { sectionId: seatSection.id, label: rowLabel, sortOrder: rowIndex },
          });
          await tx.seat.createMany({
            data: Array.from({ length: section.seatsPerRow }, (_unused, i) => ({
              seatMapId: seatMap.id,
              rowId: row.id,
              seatCategoryId: category.id,
              label: String(i + 1),
              colIndex: i + 1,
              kind: 'SEAT',
            })),
          });
        }
      }
    });

    const view = await this.getSeatMap(user, screenId);
    // Just created: the map is guaranteed to exist.
    return view as SeatMapView;
  }

  async getSeatMap(user: RequestUser, screenId: string): Promise<SeatMapView | null> {
    await this.loadOwnedScreen(user, screenId, undefined);
    return this.buildSeatMapView(screenId);
  }

  private async buildSeatMapView(screenId: string): Promise<SeatMapView | null> {
    const seatMap = await this.prisma.seatMap.findUnique({
      where: { screenId },
      include: {
        categories: { orderBy: { sortOrder: 'asc' } },
        sections: {
          orderBy: { sortOrder: 'asc' },
          include: {
            rows: {
              orderBy: { sortOrder: 'asc' },
              include: { seats: { orderBy: { colIndex: 'asc' } } },
            },
          },
        },
      },
    });
    if (!seatMap) return null;
    return {
      id: seatMap.id,
      screenId: seatMap.screenId,
      name: seatMap.name,
      categories: seatMap.categories.map((c) => ({
        id: c.id,
        name: c.name,
        colorHex: c.colorHex,
        basePriceMinor: c.basePriceMinor,
      })),
      sections: seatMap.sections.map((s) => ({
        id: s.id,
        name: s.name,
        rows: s.rows.map((r) => ({
          id: r.id,
          label: r.label,
          seats: r.seats.map((seat) => ({
            id: seat.id,
            label: seat.label,
            colIndex: seat.colIndex,
            seatCategoryId: seat.seatCategoryId,
          })),
        })),
      })),
    };
  }

  // ─── Shows (movie sessions) ───

  async scheduleShow(
    user: RequestUser,
    movieId: string,
    input: ScheduleShowInput,
  ): Promise<{ eventId: string; sessionId: string }> {
    const movie = await this.prisma.movie.findUnique({ where: { id: movieId } });
    if (!movie)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Movie not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, movie.organizationId, ORGANIZER_ROLES);

    const screen = await this.prisma.screen.findUnique({
      where: { id: input.screenId },
      include: {
        cinema: true,
        seatMap: {
          include: { categories: { orderBy: { sortOrder: 'asc' } }, seats: true },
        },
      },
    });
    if (!screen)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Screen not found.', HttpStatus.NOT_FOUND);
    if (screen.cinema.organizationId !== movie.organizationId) {
      throw new AppException(
        ErrorCodes.TENANT_FORBIDDEN,
        'The screen does not belong to this movie’s organization.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!screen.seatMap) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'The screen has no seat map; generate one before scheduling shows.',
        HttpStatus.CONFLICT,
      );
    }
    const seatMap = screen.seatMap;

    const priceByCategory = new Map(
      (input.pricing ?? []).map((p) => [p.seatCategoryId, p.priceMinor]),
    );
    const countByCategory = new Map<string, number>();
    for (const seat of seatMap.seats) {
      countByCategory.set(seat.seatCategoryId, (countByCategory.get(seat.seatCategoryId) ?? 0) + 1);
    }

    return this.prisma.$transaction(async (tx) => {
      // Serialise scheduling for this screen. Two managers filling the same screen at the
      // same moment would otherwise both read "no conflict" and both insert — the classic
      // check-then-act race, and the one that matters most here because the result is two
      // films sold into one room. Locking the screen row is enough: conflicts are always
      // between sessions on the SAME screen, so nothing broader needs to serialise, and
      // scheduling is far too infrequent for the contention to matter.
      await tx.$queryRaw`SELECT id FROM "Screen" WHERE id = ${screen.id} FOR UPDATE`;

      const conflict = await this.findConflict(tx, screen.id, {
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      });
      if (conflict) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          `Screen is already booked from ${conflict.startsAt.toISOString()} to ${conflict.endsAt.toISOString()}. Cinema screens need ${this.turnaroundMinutes} minutes between shows.`,
          HttpStatus.CONFLICT,
        );
      }

      let event = await tx.event.findFirst({
        where: { movieId, experienceType: ExperienceType.MOVIE },
      });
      if (!event) {
        let venueId = screen.cinema.venueId;
        if (!venueId) {
          const fallback = await tx.venue.findFirst({
            where: { organizationId: movie.organizationId },
          });
          if (!fallback) {
            throw new AppException(
              ErrorCodes.CONFLICT,
              'No venue is available for this organization.',
              HttpStatus.CONFLICT,
            );
          }
          venueId = fallback.id;
        }
        event = await tx.event.create({
          data: {
            organizationId: movie.organizationId,
            venueId,
            experienceType: ExperienceType.MOVIE,
            movieId,
            title: movie.title,
            slug: slugify(movie.title),
            category: 'Movie',
            status: EventStatus.PUBLISHED,
            publishedAt: new Date(),
          },
        });
      }

      const session = await tx.eventSession.create({
        data: {
          eventId: event.id,
          screenId: screen.id,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          status: SessionStatus.SCHEDULED,
        },
      });

      for (const category of seatMap.categories) {
        const quantityTotal = countByCategory.get(category.id) ?? 0;
        await tx.ticketType.create({
          data: {
            eventSessionId: session.id,
            seatCategoryId: category.id,
            name: category.name,
            priceMinor: priceByCategory.get(category.id) ?? category.basePriceMinor,
            currency: 'INR',
            quantityTotal,
            maxPerOrder: 10,
            status: 'ACTIVE',
            inventory: {
              create: { quantityTotal, quantitySold: 0, quantityHeld: 0 },
            },
          },
        });
      }

      await tx.showSeat.createMany({
        data: seatMap.seats.map((seat) => ({
          eventSessionId: session.id,
          seatId: seat.id,
          status: 'AVAILABLE',
        })),
      });

      return { eventId: event.id, sessionId: session.id };
    });
  }

  /**
   * Sessions already on a screen that a proposed window would collide with.
   *
   * CANCELLED sessions are excluded: a cancelled show has released its slot and must not
   * block the replacement, which is the whole point of cancelling it.
   *
   * The window is widened by the turnaround on BOTH sides in the query, then narrowed by
   * `windowsConflict`. The wide query is only a cheap index-friendly prefilter; the precise
   * rule stays in one place rather than being half-expressed in SQL.
   */
  private async findConflict(
    tx: Prisma.TransactionClient,
    screenId: string,
    candidate: ShowWindow,
    ignoreSessionId?: string,
  ): Promise<{ id: string; startsAt: Date; endsAt: Date } | null> {
    const gapMs = this.turnaroundMinutes * 60_000;
    const rows = await tx.eventSession.findMany({
      where: {
        screenId,
        id: ignoreSessionId ? { not: ignoreSessionId } : undefined,
        status: { not: SessionStatus.CANCELLED },
        startsAt: { lt: new Date(candidate.endsAt.getTime() + gapMs) },
        endsAt: { gt: new Date(candidate.startsAt.getTime() - gapMs) },
      },
      select: { id: true, startsAt: true, endsAt: true },
      orderBy: { startsAt: 'asc' },
    });
    const decision = decideSchedule({
      proposed: [{ index: 0, startsAt: candidate.startsAt, endsAt: candidate.endsAt }],
      existing: rows,
      turnaroundMinutes: this.turnaroundMinutes,
      // The caller has already validated the window; this call is only about collisions,
      // so `now` must not re-reject a slot for being in the past.
      now: new Date(candidate.startsAt.getTime() - 1),
    });
    const rejection = decision.rejected[0]?.rejection;
    if (rejection?.reason !== 'OVERLAPS_EXISTING_SHOW') return null;
    return rows.find((r) => r.id === rejection.conflictsWith) ?? null;
  }

  /**
   * Schedule a whole day, week or run in one request.
   *
   * Defaults to a dry run. An operator sees every decision — created, skipped, conflicted —
   * before anything is written, which is the only humane way to fill a screen: conflicts
   * come back as a list to fix in one pass rather than one failed request at a time.
   *
   * When it does write, it writes inside a SINGLE transaction with the screen row locked.
   * Either the whole accepted set lands or none of it does. A half-created schedule is the
   * worst outcome available: the operator cannot tell what exists without re-reading, and
   * re-submitting would duplicate whatever succeeded.
   */
  async bulkScheduleShows(
    user: RequestUser,
    movieId: string,
    input: BulkScheduleShowsInput,
  ): Promise<{
    dryRun: boolean;
    turnaroundMinutes: number;
    proposed: number;
    created: { sessionId: string; startsAt: Date; endsAt: Date }[];
    rejected: {
      startsAt: Date;
      endsAt: Date;
      reason: string;
      detail?: string | number;
      gapMinutes?: number;
    }[];
  }> {
    const movie = await this.prisma.movie.findUnique({ where: { id: movieId } });
    if (!movie)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Movie not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, movie.organizationId, ORGANIZER_ROLES);

    const screen = await this.prisma.screen.findUnique({
      where: { id: input.screenId },
      include: {
        cinema: true,
        seatMap: { include: { categories: { orderBy: { sortOrder: 'asc' } }, seats: true } },
      },
    });
    if (!screen)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Screen not found.', HttpStatus.NOT_FOUND);
    if (screen.cinema.organizationId !== movie.organizationId) {
      throw new AppException(
        ErrorCodes.TENANT_FORBIDDEN,
        'The screen does not belong to this movie’s organization.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (screen.cinema.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This cinema is not active; reactivate it before scheduling shows.',
        HttpStatus.CONFLICT,
      );
    }
    if (!screen.seatMap) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'The screen has no seat map; generate one before scheduling shows.',
        HttpStatus.CONFLICT,
      );
    }

    const dates = input.dates?.length
      ? [...input.dates].sort()
      : datesInRange(input.from as string, input.to as string);
    const proposed = expandSchedule({
      dates,
      times: input.times,
      // Trailers and titles: a screen booked against the bare feature length runs late.
      runtimeMinutes: movie.runtimeMinutes + input.padMinutes,
      toInstant: (date, time) => zonedWallClockToInstant(date, time, input.timezone),
    });

    const existing = await this.prisma.eventSession.findMany({
      where: { screenId: screen.id, status: { not: SessionStatus.CANCELLED } },
      select: { id: true, startsAt: true, endsAt: true },
    });

    const decision = decideSchedule({
      proposed,
      existing,
      turnaroundMinutes: this.turnaroundMinutes,
      now: new Date(),
    });

    const rejected = describeRejections(decision);
    if (input.dryRun) {
      return {
        dryRun: true,
        turnaroundMinutes: this.turnaroundMinutes,
        proposed: proposed.length,
        created: [],
        rejected,
      };
    }

    const seatMap = screen.seatMap;
    const priceByCategory = new Map(
      (input.pricing ?? []).map((p) => [p.seatCategoryId, p.priceMinor]),
    );
    const countByCategory = new Map<string, number>();
    for (const seat of seatMap.seats) {
      countByCategory.set(seat.seatCategoryId, (countByCategory.get(seat.seatCategoryId) ?? 0) + 1);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Screen" WHERE id = ${screen.id} FOR UPDATE`;

      const event = await this.ensureMovieEvent(tx, movie, screen);
      const out: { sessionId: string; startsAt: Date; endsAt: Date }[] = [];

      for (const show of decision.creatable) {
        // Re-checked inside the lock. The decision above was computed from a read taken
        // before the lock was held, so another manager may have committed in between.
        const conflict = await this.findConflict(tx, screen.id, show);
        if (conflict) {
          rejected.push({
            startsAt: show.startsAt,
            endsAt: show.endsAt,
            reason: 'OVERLAPS_EXISTING_SHOW',
            detail: conflict.id,
          });
          continue;
        }

        const session = await tx.eventSession.create({
          data: {
            eventId: event.id,
            screenId: screen.id,
            startsAt: show.startsAt,
            endsAt: show.endsAt,
            status: SessionStatus.SCHEDULED,
          },
        });
        for (const category of seatMap.categories) {
          const quantityTotal = countByCategory.get(category.id) ?? 0;
          await tx.ticketType.create({
            data: {
              eventSessionId: session.id,
              seatCategoryId: category.id,
              name: category.name,
              priceMinor: priceByCategory.get(category.id) ?? category.basePriceMinor,
              currency: 'INR',
              quantityTotal,
              maxPerOrder: 10,
              status: 'ACTIVE',
              inventory: { create: { quantityTotal, quantitySold: 0, quantityHeld: 0 } },
            },
          });
        }
        await tx.showSeat.createMany({
          data: seatMap.seats.map((seat) => ({
            eventSessionId: session.id,
            seatId: seat.id,
            status: 'AVAILABLE',
          })),
        });
        out.push({ sessionId: session.id, startsAt: show.startsAt, endsAt: show.endsAt });
      }
      return out;
    });

    await this.audit?.record({
      actorUserId: user.id,
      organizationId: movie.organizationId,
      action: 'SHOW_BULK_SCHEDULED',
      entityType: 'Screen',
      entityId: screen.id,
      metadata: {
        movieId,
        proposed: proposed.length,
        created: created.length,
        rejected: rejected.length,
        timezone: input.timezone,
      },
    });

    return {
      dryRun: false,
      turnaroundMinutes: this.turnaroundMinutes,
      proposed: proposed.length,
      created,
      rejected,
    };
  }

  /**
   * The single Event row that carries a movie's sessions.
   *
   * Movies reuse the Event/EventSession model rather than introducing a parallel "Show"
   * concept: one Event per film, one EventSession per performance. Extracted so single and
   * bulk scheduling cannot drift into creating it two different ways.
   */
  private async ensureMovieEvent(
    tx: Prisma.TransactionClient,
    movie: { id: string; title: string; organizationId: string },
    screen: { cinema: { venueId: string | null } },
  ) {
    const existing = await tx.event.findFirst({
      where: { movieId: movie.id, experienceType: ExperienceType.MOVIE },
    });
    if (existing) return existing;

    let venueId = screen.cinema.venueId;
    if (!venueId) {
      const fallback = await tx.venue.findFirst({
        where: { organizationId: movie.organizationId },
      });
      if (!fallback) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'No venue is available for this organization.',
          HttpStatus.CONFLICT,
        );
      }
      venueId = fallback.id;
    }
    return tx.event.create({
      data: {
        organizationId: movie.organizationId,
        venueId,
        experienceType: ExperienceType.MOVIE,
        movieId: movie.id,
        title: movie.title,
        slug: slugify(movie.title),
        category: 'Movie',
        status: EventStatus.PUBLISHED,
        publishedAt: new Date(),
      },
    });
  }

  async listShows(user: RequestUser, movieId: string): Promise<ShowRowView[]> {
    const movie = await this.prisma.movie.findUnique({ where: { id: movieId } });
    if (!movie)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Movie not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, movie.organizationId);

    const sessions = await this.prisma.eventSession.findMany({
      where: {
        screenId: { not: null },
        event: { movieId, experienceType: ExperienceType.MOVIE },
      },
      orderBy: { startsAt: 'asc' },
      include: { screen: { include: { cinema: { select: { name: true } } } } },
    });
    if (sessions.length === 0) return [];

    const grouped = await this.prisma.showSeat.groupBy({
      by: ['eventSessionId', 'status'],
      where: { eventSessionId: { in: sessions.map((s) => s.id) } },
      _count: { _all: true },
    });
    const totals = new Map<string, number>();
    const sold = new Map<string, number>();
    for (const g of grouped) {
      totals.set(g.eventSessionId, (totals.get(g.eventSessionId) ?? 0) + g._count._all);
      if (g.status === 'SOLD') sold.set(g.eventSessionId, g._count._all);
    }

    return sessions.map((s) => ({
      sessionId: s.id,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      screenName: s.screen?.name ?? null,
      cinemaName: s.screen?.cinema.name ?? null,
      seatsSold: sold.get(s.id) ?? 0,
      seatsTotal: totals.get(s.id) ?? 0,
    }));
  }

  // ─── Public seat layout ───

  async getPublicSeatLayout(sessionId: string) {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: sessionId },
      include: {
        ticketTypes: true,
        showSeats: true,
        screen: {
          include: {
            seatMap: {
              include: {
                categories: { orderBy: { sortOrder: 'asc' } },
                sections: {
                  orderBy: { sortOrder: 'asc' },
                  include: {
                    rows: {
                      orderBy: { sortOrder: 'asc' },
                      include: { seats: { orderBy: { colIndex: 'asc' } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!session || !session.screen?.seatMap) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Show not found or has no seat layout.',
        HttpStatus.NOT_FOUND,
      );
    }
    const seatMap = session.screen.seatMap;

    const ticketTypeByCategory = new Map(
      session.ticketTypes
        .filter((t) => t.seatCategoryId)
        .map((t) => [t.seatCategoryId as string, t]),
    );
    const statusBySeat = new Map(session.showSeats.map((ss) => [ss.seatId, ss.status]));

    return {
      sessionId: session.id,
      categories: seatMap.categories.map((c) => {
        const ticketType = ticketTypeByCategory.get(c.id);
        return {
          id: c.id,
          ticketTypeId: ticketType?.id ?? null,
          name: c.name,
          colorHex: c.colorHex,
          priceMinor: ticketType?.priceMinor ?? c.basePriceMinor,
        };
      }),
      sections: seatMap.sections.map((s) => ({
        name: s.name,
        rows: s.rows.map((r) => ({
          label: r.label,
          seats: r.seats.map((seat) => ({
            id: seat.id,
            label: seat.label,
            colIndex: seat.colIndex,
            categoryId: seat.seatCategoryId,
            status: statusBySeat.get(seat.id) ?? 'AVAILABLE',
          })),
        })),
      })),
    };
  }
}
