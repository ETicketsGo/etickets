import { HttpStatus, Injectable } from '@nestjs/common';
import { EventStatus, ExperienceType, Role, SessionStatus } from '@eticketsgo/shared-types';
import type { GenerateSeatMapInput, ScheduleShowInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import { slugify } from '../movies/movies.service';
import type { RequestUser } from '../common/decorators';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

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
  ) {}

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
