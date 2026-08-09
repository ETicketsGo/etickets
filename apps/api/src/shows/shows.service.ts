import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  BookingStatus,
  EventStatus,
  ExperienceType,
  Role,
  SessionStatus,
} from '@eticketsgo/shared-types';
import type {
  BulkScheduleShowsInput,
  CopyScheduleInput,
  GenerateSeatMapInput,
  RescheduleShowInput,
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
import { resolveEffectiveLayout, type LayoutStatus } from './seat-layout-versioning';
import {
  evaluateOperation,
  type ShowCommitments,
  type ShowOperation,
  type ShowState,
} from './show-operations';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/**
 * Widest schedule window one request may ask for, in local days.
 *
 * A week view needs seven. The ceiling keeps the single grouped seat-count query cheap and
 * stops the endpoint becoming a way to pull an entire season in one call.
 */
export const MAX_SCHEDULE_RANGE_DAYS = 14;

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

/**
 * The wall-clock time an instant reads as in a given zone, as HH:mm.
 *
 * The inverse of zonedWallClockToInstant, and the reason copying a day is DST-safe: the
 * source show's LOCAL time is recovered and re-resolved against the target date, so a
 * 10:30 show stays 10:30 even if the two dates sit on opposite sides of a clock change.
 * Adding 24h to the UTC instant — the obvious implementation — silently shifts every show
 * by an hour across a transition.
 */
export function instantToZonedWallClock(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}

/** The next calendar date LABEL. Label arithmetic, so DST cannot add or drop a day. */
function nextDateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(d.getTime() + 24 * 60 * 60_000).toISOString().slice(0, 10);
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

/** Shapes one session row for the organizer, shared by both listing endpoints. */
function toShowRow(
  s: {
    id: string;
    startsAt: Date;
    endsAt: Date;
    status: string;
    screenId: string | null;
    screen: { id: string; name: string; cinema: { id: string; name: string } } | null;
    event: { movieId: string | null; movie: { title: string } | null };
    ticketTypes?: { salesStartAt: Date | null; salesEndAt: Date | null }[];
  },
  sold: Map<string, number>,
  totals: Map<string, number>,
): ShowRowView {
  const types = s.ticketTypes ?? [];
  // A single unbounded type makes that edge unbounded: if anything is on sale with no
  // start, the show is already open.
  const anyOpenEnded = types.some((t) => t.salesStartAt === null);
  const anyNeverCloses = types.some((t) => t.salesEndAt === null);
  const starts = types.map((t) => t.salesStartAt).filter((d): d is Date => d !== null);
  const ends = types.map((t) => t.salesEndAt).filter((d): d is Date => d !== null);
  return {
    sessionId: s.id,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    screenId: s.screen?.id ?? null,
    screenName: s.screen?.name ?? null,
    cinemaId: s.screen?.cinema.id ?? null,
    cinemaName: s.screen?.cinema.name ?? null,
    movieId: s.event.movieId,
    movieTitle: s.event.movie?.title ?? null,
    status: s.status,
    salesStartAt:
      anyOpenEnded || starts.length === 0
        ? null
        : new Date(Math.min(...starts.map((d) => d.getTime()))),
    salesEndAt:
      anyNeverCloses || ends.length === 0
        ? null
        : new Date(Math.max(...ends.map((d) => d.getTime()))),
    seatsSold: sold.get(s.id) ?? 0,
    seatsTotal: totals.get(s.id) ?? 0,
  };
}

/** The GET/POST seat-map response shape (categories + sections→rows→seats). */
export interface SeatMapView {
  id: string;
  screenId: string;
  name: string | null;
  /**
   * Version identity. A layout is no longer "the" seat map for a screen — it is one version
   * among several, and a caller that cannot tell which one it is holding will eventually
   * render last month's room.
   */
  version: number;
  status: LayoutStatus;
  effectiveFrom: Date | null;
  publishedAt: Date | null;
  clonedFromId: string | null;
  categories: { id: string; name: string; colorHex: string | null; basePriceMinor: number }[];
  sections: {
    id: string;
    name: string;
    rows: {
      id: string;
      label: string;
      seats: {
        id: string;
        label: string;
        colIndex: number;
        seatCategoryId: string;
        kind: string;
      }[];
    }[];
  }[];
}

export interface ShowRowView {
  sessionId: string;
  startsAt: Date;
  endsAt: Date;
  /**
   * Added for the organizer schedule. Without these a day view cannot group shows by
   * screen or render sales state, and would have to infer both — which is how a paused
   * show ends up looking bookable to the person who paused it.
   */
  screenId: string | null;
  screenName: string | null;
  cinemaId: string | null;
  cinemaName: string | null;
  movieId: string | null;
  movieTitle: string | null;
  status: string;
  /**
   * The show's effective booking window, derived from its ticket types.
   *
   * The window is stored per TicketType, but an operator asks about the SHOW: "can anyone
   * buy a seat for this yet". So the earliest open and the latest close across its types
   * are reported, and a type with no bound makes that side unbounded — if anything is
   * already on sale, the show is on sale.
   *
   * Null on both sides means always open, which is what an unconfigured show does today.
   */
  salesStartAt: Date | null;
  salesEndAt: Date | null;
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

  /**
   * A screen must be in service before anything new is scheduled or reopened on it.
   *
   * Applies only to NEW commitments. Shows already on a screen that goes into maintenance
   * are deliberately left alone — see updateScreen — because cancelling something people
   * have paid for must never be a side effect of a status change.
   */
  private assertScreenUsable(screen: { status: string; name: string }) {
    if (screen.status === 'ACTIVE') return;
    throw new AppException(
      ErrorCodes.CONFLICT,
      screen.status === 'MAINTENANCE'
        ? `${screen.name} is under maintenance and cannot take new shows.`
        : `${screen.name} is not in service.`,
      HttpStatus.CONFLICT,
    );
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

    // Still one-shot: this creates the screen's FIRST layout. Changing an existing one goes
    // through clone → edit draft → publish, so a published layout is never mutated under a
    // show that has already sold seats from it.
    const existing = await this.prisma.seatMap.findFirst({ where: { screenId } });
    if (existing) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This screen already has a seat layout. Clone the current version to change it — published layouts are frozen because sold tickets point at their seats.',
        HttpStatus.CONFLICT,
      );
    }

    const createdAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const seatMap = await tx.seatMap.create({
        data: {
          screenId,
          name: input.name,
          version: 1,
          status: 'PUBLISHED',
          publishedAt: createdAt,
          // In effect immediately: a screen's first layout has nothing to supersede.
          effectiveFrom: createdAt,
        },
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

  /**
   * The layout a caller means when they say "this screen's seat map" without naming a
   * version: the newest published one, falling back to a draft if nothing is published yet.
   *
   * Existing callers asked for the screen's single map. Rather than making all of them
   * version-aware at once, this preserves that question and gives the best current answer.
   */
  private async currentSeatMapId(screenId: string): Promise<string | null> {
    const published = await this.prisma.seatMap.findFirst({
      where: { screenId, status: 'PUBLISHED' },
      orderBy: [{ version: 'desc' }],
      select: { id: true },
    });
    if (published) return published.id;
    const draft = await this.prisma.seatMap.findFirst({
      where: { screenId },
      orderBy: [{ version: 'desc' }],
      select: { id: true },
    });
    return draft?.id ?? null;
  }

  private async buildSeatMapView(screenId: string): Promise<SeatMapView | null> {
    const id = await this.currentSeatMapId(screenId);
    if (!id) return null;
    return this.buildSeatMapViewById(id);
  }

  private async buildSeatMapViewById(seatMapId: string): Promise<SeatMapView | null> {
    const seatMap = await this.prisma.seatMap.findUnique({
      where: { id: seatMapId },
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
      version: seatMap.version,
      status: seatMap.status as LayoutStatus,
      effectiveFrom: seatMap.effectiveFrom,
      publishedAt: seatMap.publishedAt,
      clonedFromId: seatMap.clonedFromId,
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
            kind: seat.kind,
          })),
        })),
      })),
    };
  }

  /**
   * The seat layout a show starting at `startsAt` must be built from, with its seats.
   *
   * Scheduling used to read `screen.seatMap` — the one and only map. Now a screen has a
   * history of versions, so the question has to include WHEN: a show tomorrow may legitimately
   * use a different room from a show tonight, and that is the entire point of versioning.
   *
   * Throws rather than falling back. If no version is in effect for that date, quietly using
   * the newest one would sell seats from a room that does not exist yet.
   */
  private async resolveLayoutForShow(screenId: string, startsAt: Date) {
    const versions = await this.prisma.seatMap.findMany({
      where: { screenId },
      select: {
        id: true,
        version: true,
        status: true,
        effectiveFrom: true,
        publishedAt: true,
        createdAt: true,
      },
    });

    if (versions.length === 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'The screen has no seat map; generate one before scheduling shows.',
        HttpStatus.CONFLICT,
      );
    }

    const chosen = resolveEffectiveLayout(
      versions.map((v) => ({ ...v, status: v.status as LayoutStatus })),
      startsAt,
    );
    if (!chosen) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'No published seat layout is in effect for that date. Publish a layout effective on or before it, or move the show.',
        HttpStatus.CONFLICT,
        { screenId },
      );
    }

    const full = await this.prisma.seatMap.findUniqueOrThrow({
      where: { id: chosen.id },
      include: { categories: { orderBy: { sortOrder: 'asc' } }, seats: true },
    });
    return full;
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
      include: { cinema: true },
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
    this.assertScreenUsable(screen);
    // Resolved for THIS show's start time, not "the screen's map" — see resolveLayoutForShow.
    const seatMap = await this.resolveLayoutForShow(screen.id, input.startsAt);

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
          // Pin the layout version. Recoverable from the seats, but recording it lets the
          // schedule say which room tomorrow's show uses before a seat has been touched.
          seatMapId: seatMap.id,
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
      include: { cinema: true },
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
    this.assertScreenUsable(screen);

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

    /*
      One layout for the whole batch, and it must genuinely be one.

      A range can straddle the date a new layout version takes effect, in which case the
      earlier shows belong in the old room and the later ones in the new. Quietly using one
      map for both would build half the batch against a room that is not there on the night.
      Rather than guess, the batch is refused with the boundary named, and the operator
      schedules the two sides separately — which is what they actually meant.
    */
    // Emptiness first: an expansion can legitimately produce nothing, and dereferencing
    // proposed[0] before checking turns that into a 500 instead of an empty dry run.
    const seatMap = await this.resolveLayoutForShow(screen.id, proposed[0]?.startsAt ?? new Date());
    if (proposed.length > 1) {
      const last = await this.resolveLayoutForShow(
        screen.id,
        proposed[proposed.length - 1].startsAt,
      );
      if (last.id !== seatMap.id) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          `This range crosses a seat layout change (v${seatMap.version} → v${last.version}). Schedule the dates before and after the change separately, so each show is built against the room it will actually use.`,
          HttpStatus.CONFLICT,
          { fromVersion: seatMap.version, toVersion: last.version },
        );
      }
    }

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
            seatMapId: seatMap.id,
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

  /**
   * Copy a screen's day onto another date and/or another screen.
   *
   * A convenience over the bulk engine, not a second scheduler. It reads the source day,
   * recovers each show's LOCAL start time, and hands those times to `bulkScheduleShows`
   * against the target — so overlap, turnaround, proposal-vs-proposal checking, the screen
   * row lock, transactional creation and the dry-run default all come from one place and
   * cannot drift.
   *
   * DST-safe by construction. The source times are recovered as wall-clock and re-resolved
   * against the target date in the venue's zone, so a 10:30 show stays 10:30 even when the
   * two dates sit either side of a clock change. Adding 24 hours to the UTC instant — the
   * obvious implementation — shifts every show by an hour across a transition.
   *
   * Only the schedule is copied. Bookings are never moved: these are new future sessions.
   */
  async copySchedule(user: RequestUser, movieId: string, input: CopyScheduleInput) {
    const targetScreenId = input.targetScreenId ?? input.sourceScreenId;

    const movie = await this.prisma.movie.findUnique({ where: { id: movieId } });
    if (!movie)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Movie not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, movie.organizationId, ORGANIZER_ROLES);

    // Authorize the SOURCE too. The target is validated by bulkScheduleShows, but reading
    // another tenant's schedule would leak their programming even if nothing were created.
    const source = await this.prisma.screen.findUnique({
      where: { id: input.sourceScreenId },
      include: { cinema: true },
    });
    if (!source)
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Source screen not found.',
        HttpStatus.NOT_FOUND,
      );
    if (source.cinema.organizationId !== movie.organizationId) {
      throw new AppException(
        ErrorCodes.TENANT_FORBIDDEN,
        'The source screen does not belong to this movie’s organization.',
        HttpStatus.FORBIDDEN,
      );
    }

    // The UTC window covering the source LOCAL day. Both edges are resolved through the
    // zone, so a 23- or 25-hour DST day is exactly covered rather than clipped or doubled.
    const dayStart = zonedWallClockToInstant(input.sourceDate, '00:00', input.timezone);
    const dayEnd = zonedWallClockToInstant(
      nextDateLabel(input.sourceDate),
      '00:00',
      input.timezone,
    );

    const sourceSessions = await this.prisma.eventSession.findMany({
      where: {
        screenId: input.sourceScreenId,
        // A cancelled show is not part of the day's programme and must not be copied
        // forward; copying it would resurrect something the operator deliberately stopped.
        status: { not: SessionStatus.CANCELLED },
        startsAt: { gte: dayStart, lt: dayEnd },
        event: { movieId },
      },
      select: { startsAt: true },
      orderBy: { startsAt: 'asc' },
    });

    if (!sourceSessions.length) {
      return {
        dryRun: input.dryRun,
        sourceDate: input.sourceDate,
        targetDate: input.targetDate,
        targetScreenId,
        turnaroundMinutes: this.turnaroundMinutes,
        proposed: 0,
        created: [],
        rejected: [],
        times: [] as string[],
      };
    }

    const times = [
      ...new Set(sourceSessions.map((s) => instantToZonedWallClock(s.startsAt, input.timezone))),
    ].sort();

    const result = await this.bulkScheduleShows(user, movieId, {
      screenId: targetScreenId,
      dates: [input.targetDate],
      times,
      // The source sessions already include whatever padding was applied when they were
      // created; re-adding it would stretch each copied show a little further every time a
      // day was copied forward.
      padMinutes: 0,
      timezone: input.timezone,
      pricing: input.pricing,
      dryRun: input.dryRun,
    });

    if (!input.dryRun) {
      await this.audit?.record({
        actorUserId: user.id,
        organizationId: movie.organizationId,
        action: 'SHOW_SCHEDULE_COPIED',
        entityType: 'Screen',
        entityId: targetScreenId,
        metadata: {
          movieId,
          sourceScreenId: input.sourceScreenId,
          sourceDate: input.sourceDate,
          targetDate: input.targetDate,
          timezone: input.timezone,
          times,
          created: result.created.length,
          rejected: result.rejected.length,
        },
      });
    }

    return {
      ...result,
      sourceDate: input.sourceDate,
      targetDate: input.targetDate,
      targetScreenId,
      /** The local times recovered from the source day, so a dry run is self-explaining. */
      times,
    };
  }

  // ─── Sales control and cancellation ───

  /**
   * Load a session, authorize the caller through its cinema, and count what is booked.
   *
   * Every sales operation needs the same three things, and they must be read together:
   * deciding on a stale commitment count is how an edit slips past a booking that arrived
   * a moment earlier.
   */
  private async loadOwnedSession(user: RequestUser, sessionId: string) {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: sessionId },
      include: { event: { select: { organizationId: true, movieId: true } }, screen: true },
    });
    if (!session)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Show not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, session.event.organizationId, ORGANIZER_ROLES);
    return session;
  }

  /**
   * What is committed against a show right now.
   *
   * Expired holds are excluded by comparing `holdExpiresAt` to now rather than trusting the
   * booking's status: a lapsed hold that the sweeper has not yet collected is not a reason
   * to refuse an operator, and treating it as one would make edits fail unpredictably for
   * ten minutes after anyone browsed the show.
   */
  private async commitmentsFor(sessionId: string, now = new Date()): Promise<ShowCommitments> {
    const rows = await this.prisma.booking.groupBy({
      by: ['status'],
      where: {
        eventSessionId: sessionId,
        OR: [
          { status: { in: [BookingStatus.CONFIRMED, BookingStatus.PARTIALLY_REFUNDED] } },
          { status: BookingStatus.PENDING_PAYMENT, holdExpiresAt: { gt: now } },
        ],
      },
      _count: { _all: true },
    });
    const count = (s: BookingStatus) => rows.find((r) => r.status === s)?._count._all ?? 0;
    return {
      // A pending-payment booking IS the hold in this model: the seats are flipped to HELD
      // against it and released when it lapses. Reported as both so the policy can talk
      // about "someone is mid-checkout" without the caller re-deriving it.
      activeHolds: count(BookingStatus.PENDING_PAYMENT),
      pendingPayment: count(BookingStatus.PENDING_PAYMENT),
      confirmed: count(BookingStatus.CONFIRMED) + count(BookingStatus.PARTIALLY_REFUNDED),
    };
  }

  /** Shared guard: evaluate the policy and turn a refusal into the right HTTP error. */
  private async authorizeOperation(user: RequestUser, sessionId: string, operation: ShowOperation) {
    const session = await this.loadOwnedSession(user, sessionId);
    const commitments = await this.commitmentsFor(sessionId);
    const verdict = evaluateOperation({
      operation,
      state: session.status as ShowState,
      startsAt: session.startsAt,
      commitments,
      now: new Date(),
    });
    if (!verdict.allowed) {
      /**
       * The policy's specific reason travels in `details`, not just in the message.
       *
       * Without it a client sees only `code: 'CONFLICT'` and an English sentence, so
       * telling "someone has paid" apart from "someone is mid-checkout" means regex-matching
       * prose — which breaks the moment the wording changes or is translated. The message
       * stays the human text; this is the stable handle a UI can branch on.
       */
      throw new AppException(ErrorCodes.CONFLICT, verdict.message, HttpStatus.CONFLICT, {
        reason: verdict.code,
      });
    }
    return { session, commitments, idempotent: 'idempotent' in verdict };
  }

  /**
   * Stop selling a show without cancelling it.
   *
   * ── WHAT HAPPENS TO EXISTING HOLDS ────────────────────────────────────────────────
   * They are LEFT ALONE and allowed to run out their TTL. This is a deliberate choice
   * between two defensible options.
   *
   * A customer who is on the payment page when a manager pauses the show has already picked
   * seats and may already have been charged by the provider. Invalidating their hold
   * mid-transaction produces the worst outcome available: money taken for seats the system
   * has since released. Letting the hold finish costs at most a handful of extra tickets on
   * a show that is closing anyway, and those seats were already spoken for.
   *
   * Confirmed bookings are untouched and sold seats are never released.
   */
  async pauseSales(user: RequestUser, sessionId: string, reason?: string) {
    const { session, idempotent } = await this.authorizeOperation(user, sessionId, 'PAUSE');
    if (idempotent) return { sessionId, status: session.status, changed: false };

    const updated = await this.prisma.eventSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.PAUSED },
    });
    await this.recordShowAudit(user, session, 'SHOW_SALES_PAUSED', {
      from: session.status,
      to: SessionStatus.PAUSED,
      reason,
    });
    return { sessionId, status: updated.status, changed: true };
  }

  /** Put a paused show back on sale. Cancellation is never undone this way. */
  async reopenSales(user: RequestUser, sessionId: string, reason?: string) {
    const { session, idempotent } = await this.authorizeOperation(user, sessionId, 'REOPEN');
    if (idempotent) return { sessionId, status: session.status, changed: false };
    // Selling seats in a room that cannot open is worse than leaving the show paused.
    if (session.screen) this.assertScreenUsable(session.screen);

    const updated = await this.prisma.eventSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.SCHEDULED },
    });
    await this.recordShowAudit(user, session, 'SHOW_SALES_REOPENED', {
      from: session.status,
      to: SessionStatus.SCHEDULED,
      reason,
    });
    return { sessionId, status: updated.status, changed: true };
  }

  /**
   * Cancel a show.
   *
   * The session is never deleted and no financial record is touched. Cancelling marks the
   * show and releases inventory that nobody has paid for; what happens to the money is the
   * refund subsystem's job, and this does not reach into it.
   *
   * ── WHY NO REFUNDS ARE ISSUED HERE ────────────────────────────────────────────────
   * Refunds go through a provider. Calling one inside this transaction would hold a
   * database transaction open across a network call to Razorpay — the exact pattern the
   * platform's own guidance forbids, because a slow provider then blocks the row locks that
   * seat inventory depends on.
   *
   * Affected bookings are therefore REPORTED, not refunded: the response names them so the
   * caller can route them into the existing refund workflow. Inventing a second refund path
   * here would be a worse outcome than an explicit handoff.
   */
  async cancelShow(user: RequestUser, sessionId: string, reason: string) {
    const { session, commitments, idempotent } = await this.authorizeOperation(
      user,
      sessionId,
      'CANCEL',
    );
    if (idempotent) {
      return {
        sessionId,
        status: session.status,
        changed: false,
        bookingsRequiringRefund: [] as string[],
      };
    }

    const affected = await this.prisma.booking.findMany({
      where: {
        eventSessionId: sessionId,
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.PARTIALLY_REFUNDED] },
      },
      select: { id: true, reference: true },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.eventSession.update({
        where: { id: sessionId },
        data: { status: SessionStatus.CANCELLED },
      });
      // Release only what nobody owns. SOLD seats stay SOLD: the booking behind them is
      // still real until a refund says otherwise, and releasing them would let the same
      // seat be sold twice for a show that may yet be reinstated as a new session.
      await tx.showSeat.updateMany({
        where: { eventSessionId: sessionId, status: { in: ['AVAILABLE', 'HELD'] } },
        data: { status: 'UNAVAILABLE', holdBookingId: null, holdExpiresAt: null },
      });
    });

    await this.recordShowAudit(user, session, 'SHOW_CANCELLED', {
      from: session.status,
      to: SessionStatus.CANCELLED,
      reason,
      confirmedBookings: commitments.confirmed,
      activeHolds: commitments.activeHolds,
    });

    return {
      sessionId,
      status: SessionStatus.CANCELLED,
      changed: true,
      /**
       * Handed back rather than acted on. These need the existing refund workflow; this
       * endpoint deliberately does not start it.
       */
      bookingsRequiringRefund: affected.map((b) => b.reference ?? b.id),
    };
  }

  /**
   * Move a future show to a new start time.
   *
   * The end time is recomputed from the film's runtime rather than accepted, so a slot can
   * never disagree with the length of what is being shown. Overlap is re-checked under the
   * same screen-row lock that scheduling uses, because moving a show into an occupied slot
   * is the same defect as creating one there.
   */
  async rescheduleShow(user: RequestUser, sessionId: string, input: RescheduleShowInput) {
    const { session } = await this.authorizeOperation(user, sessionId, 'EDIT_TIME');
    if (!session.screenId) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This show is not assigned to a screen.',
        HttpStatus.CONFLICT,
      );
    }
    const movie = session.event.movieId
      ? await this.prisma.movie.findUnique({ where: { id: session.event.movieId } })
      : null;
    if (!movie) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This show has no movie to take a runtime from.',
        HttpStatus.CONFLICT,
      );
    }

    const startsAt = input.startsAt;
    const endsAt = new Date(
      startsAt.getTime() + (movie.runtimeMinutes + input.padMinutes) * 60_000,
    );
    const screenId = session.screenId;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Screen" WHERE id = ${screenId} FOR UPDATE`;
      // Ignore this session's own current window, or a show would always collide with
      // itself and no reschedule could ever succeed.
      const conflict = await this.findConflict(tx, screenId, { startsAt, endsAt }, sessionId);
      if (conflict) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          `Screen is already booked from ${conflict.startsAt.toISOString()} to ${conflict.endsAt.toISOString()}.`,
          HttpStatus.CONFLICT,
          { reason: 'OVERLAPS_EXISTING_SHOW', conflictsWith: conflict.id },
        );
      }
      return tx.eventSession.update({ where: { id: sessionId }, data: { startsAt, endsAt } });
    });

    await this.recordShowAudit(user, session, 'SHOW_RESCHEDULED', {
      from: { startsAt: session.startsAt, endsAt: session.endsAt },
      to: { startsAt, endsAt },
    });
    return { sessionId, startsAt: updated.startsAt, endsAt: updated.endsAt };
  }

  /** One audit shape for every scheduling operation, so the trail is queryable. */
  private async recordShowAudit(
    user: RequestUser,
    session: { id: string; screenId: string | null; event: { organizationId: string } },
    action: string,
    metadata: Record<string, unknown>,
  ) {
    await this.audit?.record({
      actorUserId: user.id,
      organizationId: session.event.organizationId,
      action,
      entityType: 'EventSession',
      entityId: session.id,
      metadata: { screenId: session.screenId, ...metadata },
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
      include: {
        screen: { include: { cinema: { select: { id: true, name: true } } } },
        event: { select: { movieId: true, movie: { select: { title: true } } } },
        ticketTypes: { select: { salesStartAt: true, salesEndAt: true } },
      },
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

    return sessions.map((s) => toShowRow(s, sold, totals));
  }

  /**
   * One cinema's schedule for one LOCAL day, which is how a theater actually works.
   *
   * The existing listing is per-movie, and an operator does not think per-movie: they think
   * "what is on Screen 2 today". Building that from the per-movie endpoint would mean the
   * client fetching every film and reassembling the day, which is both slow and a place for
   * the two views to disagree.
   *
   * The day window is resolved through the venue's zone, not a UTC midnight, for the same
   * reason copying is: a 23:45 show belongs to the day the operator calls it.
   */
  async cinemaSchedule(
    user: RequestUser,
    cinemaId: string,
    params: { date?: string; from?: string; to?: string; timezone: string },
  ): Promise<ShowRowView[]> {
    const cinema = await this.prisma.cinema.findUnique({ where: { id: cinemaId } });
    if (!cinema)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Cinema not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, cinema.organizationId);

    /**
     * A single local day, or an inclusive local-date RANGE for week planning.
     *
     * `date` remains supported and unchanged, so the day view is untouched. A range is
     * expressed as first and last LOCAL calendar dates inclusive — "Mon to Sun" means what
     * an operator means by it — and resolved to instants through the cinema's zone, so a
     * 23:45 show belongs to the day it is advertised on rather than to UTC midnight.
     *
     * Bounded at 14 days. A week view needs seven; the ceiling exists so an unbounded query
     * cannot be used to pull a cinema's entire programme in one unauthenticated-feeling
     * request, and so the single grouped seat-count query below stays cheap.
     */
    const startLabel = params.from ?? params.date;
    const endLabel = params.to ?? params.date;
    if (!startLabel || !endLabel) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Provide either a date or a from/to range.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (endLabel < startLabel) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'The range ends before it starts.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const spanDays = datesInRange(startLabel, endLabel).length;
    if (spanDays === 0 || spanDays > MAX_SCHEDULE_RANGE_DAYS) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `A schedule range must cover between 1 and ${MAX_SCHEDULE_RANGE_DAYS} days.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const from = zonedWallClockToInstant(startLabel, '00:00', params.timezone);
    const to = zonedWallClockToInstant(nextDateLabel(endLabel), '00:00', params.timezone);

    const sessions = await this.prisma.eventSession.findMany({
      where: {
        startsAt: { gte: from, lt: to },
        screen: { cinemaId },
        event: { experienceType: ExperienceType.MOVIE },
      },
      // Chronological first: a week view groups by local day, and a day view reads as a
      // timeline. Grouping by screen is the client's job and is cheap; re-sorting a
      // screen-ordered list into time order is not.
      orderBy: [{ startsAt: 'asc' }, { screenId: 'asc' }],
      include: {
        screen: { include: { cinema: { select: { id: true, name: true } } } },
        event: { select: { movieId: true, movie: { select: { title: true } } } },
        ticketTypes: { select: { salesStartAt: true, salesEndAt: true } },
      },
    });
    if (sessions.length === 0) return [];

    // One grouped query for the whole day rather than one per show: a busy multiplex day is
    // dozens of sessions and this is the operator's landing page.
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
    return sessions.map((s) => toShowRow(s, sold, totals));
  }

  // ─── Public seat layout ───

  /**
   * The layout a show's seats actually belong to, read from the seats themselves.
   *
   * The authoritative answer when `EventSession.seatMapId` was never set. One seat is enough:
   * a session's ShowSeat rows are materialised from a single layout in one transaction.
   */
  private async layoutFromShowSeats(sessionId: string) {
    const anySeat = await this.prisma.showSeat.findFirst({
      where: { eventSessionId: sessionId },
      select: { seat: { select: { seatMapId: true } } },
    });
    if (!anySeat) return null;
    return this.prisma.seatMap.findUnique({
      where: { id: anySeat.seat.seatMapId },
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
  }

  async getPublicSeatLayout(sessionId: string) {
    /*
      Reads the layout version PINNED TO THE SHOW, not the screen's current one.

      This is the single most important consequence of versioning. Reading
      `session.screen.seatMap` — which is what this did — would render tomorrow's re-seated
      room to a customer looking at a show that was sold from the old layout: seats that no
      longer exist, prices from a different tier, and a seat map that disagrees with the
      ticket in their hand.

      `session.seatMap` is set at scheduling time and backfilled for every pre-existing show,
      so the answer is always the room the show is actually being played in.
    */
    const session = await this.prisma.eventSession.findUnique({
      where: { id: sessionId },
      include: {
        ticketTypes: true,
        showSeats: true,
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
    });
    if (!session) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Show not found or has no seat layout.',
        HttpStatus.NOT_FOUND,
      );
    }

    /*
      Fall back to the show's own seats when the pin is missing.

      `seatMapId` is a record of a decision, not the ground truth — the seats are. Any code
      path that creates an EventSession without going through `scheduleShow` leaves the
      column null, and the seed does exactly that, which took the whole customer booking
      journey down with a 404 in CI while passing locally against an older database.

      Deriving from ShowSeat -> Seat -> seatMap is the same answer the migration computed for
      pre-existing shows, so old rows, seeded rows and scheduled rows all resolve identically
      and no future caller can forget.
    */
    const seatMap = session.seatMap ?? (await this.layoutFromShowSeats(sessionId));
    if (!seatMap) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Show not found or has no seat layout.',
        HttpStatus.NOT_FOUND,
      );
    }

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
