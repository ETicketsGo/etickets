import { HttpStatus, Injectable } from '@nestjs/common';
import { BookingStatus, Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { OVERRIDE_LABEL, type OverrideKind } from './seat-overrides';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/** The counts a duty manager reads at a glance. */
export interface OccupancySnapshot {
  sessionId: string;
  movieTitle: string | null;
  screenId: string | null;
  screenName: string | null;
  cinemaId: string | null;
  cinemaName: string | null;
  /** The cinema's own zone. Every local time a client renders must use this. */
  timezone: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;

  seatsTotal: number;
  /** Seats that could ever be sold — gaps excluded. */
  capacity: number;
  sold: number;
  held: number;
  available: number;
  blocked: number;
  /** Blocked seats broken down by why. */
  blockedByKind: { kind: OverrideKind; label: string; count: number }[];
  house: number;

  /**
   * Sold as a share of what the public could actually buy.
   *
   * The denominator excludes blocked seats. Measuring against raw capacity would report a
   * sold-out show as 94% because six seats were comped, and every occupancy number finance
   * looks at would be quietly wrong in the same direction.
   */
  occupancyPercent: number | null;

  revenueMinor: number;
  pendingPaymentMinor: number;
  currency: string;
  /** Seats sold per hour since sales opened. Null until there is enough history to mean anything. */
  salesPacePerHour: number | null;
  /** When this snapshot was taken, so a stale dashboard can say so. */
  observedAt: Date;
}

export interface LiveSeat {
  seatId: string;
  label: string;
  row: string;
  colIndex: number;
  kind: string;
  categoryId: string;
  status: string;
  overrideKind: OverrideKind | null;
  overrideReason: string | null;
  overrideBy: string | null;
  overrideAt: Date | null;
  overrideExpiresAt: Date | null;
  /** True only while a customer is genuinely mid-checkout. */
  heldNow: boolean;
}

@Injectable()
export class LiveOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
  ) {}

  private async loadOwnedSession(user: RequestUser, sessionId: string) {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: sessionId },
      include: {
        event: { select: { organizationId: true, movie: { select: { title: true } } } },
        screen: {
          select: {
            id: true,
            name: true,
            cinema: { select: { id: true, name: true, timezone: true } },
          },
        },
      },
    });
    if (!session) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Show not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, session.event.organizationId, ORGANIZER_ROLES);
    return session;
  }

  // ── Occupancy ───────────────────────────────────────────────────────────────────

  /** Live counts and money for one show. */
  async occupancy(user: RequestUser, sessionId: string): Promise<OccupancySnapshot> {
    const session = await this.loadOwnedSession(user, sessionId);
    return this.snapshotFor(session, new Date());
  }

  /**
   * Every show at a cinema on one day, for the operations board.
   *
   * Deliberately one method rather than N calls to `occupancy`: a busy multiplex has fifty
   * shows a day and a dashboard that issued fifty round trips per refresh would be the
   * slowest page in the product.
   */
  async cinemaOccupancy(
    user: RequestUser,
    cinemaId: string,
    from: Date,
    to: Date,
  ): Promise<OccupancySnapshot[]> {
    const cinema = await this.prisma.cinema.findUnique({ where: { id: cinemaId } });
    if (!cinema) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Cinema not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, cinema.organizationId, ORGANIZER_ROLES);

    const sessions = await this.prisma.eventSession.findMany({
      where: { screen: { cinemaId }, startsAt: { gte: from, lte: to } },
      orderBy: [{ startsAt: 'asc' }],
      include: {
        event: { select: { organizationId: true, movie: { select: { title: true } } } },
        screen: {
          select: {
            id: true,
            name: true,
            cinema: { select: { id: true, name: true, timezone: true } },
          },
        },
      },
    });
    if (sessions.length === 0) return [];

    const now = new Date();
    return Promise.all(sessions.map((s) => this.snapshotFor(s, now)));
  }

  private async snapshotFor(
    session: {
      id: string;
      startsAt: Date;
      endsAt: Date;
      status: string;
      screenId: string | null;
      event: { movie: { title: string } | null };
      screen: {
        id: string;
        name: string;
        cinema: { id: string; name: string; timezone: string };
      } | null;
    },
    now: Date,
  ): Promise<OccupancySnapshot> {
    const [byStatus, byKind, gaps, money, firstSale] = await Promise.all([
      this.prisma.showSeat.groupBy({
        by: ['status'],
        where: { eventSessionId: session.id },
        _count: { _all: true },
      }),
      this.prisma.showSeat.groupBy({
        by: ['overrideKind'],
        where: { eventSessionId: session.id, overrideKind: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.showSeat.count({
        where: { eventSessionId: session.id, seat: { kind: 'GAP' } },
      }),
      this.prisma.booking.groupBy({
        by: ['status', 'currency'],
        where: {
          eventSessionId: session.id,
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.PENDING_PAYMENT] },
        },
        _sum: { totalMinor: true },
      }),
      this.prisma.booking.findFirst({
        where: { eventSessionId: session.id, status: BookingStatus.CONFIRMED },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const countOf = (status: string) => byStatus.find((r) => r.status === status)?._count._all ?? 0;

    const sold = countOf('SOLD');
    const blocked = countOf('BLOCKED');
    const available = countOf('AVAILABLE');
    const seatsTotal = byStatus.reduce((sum, r) => sum + r._count._all, 0);

    /*
      HELD is counted live rather than trusted from the column.

      An expired hold whose sweeper has not run still reads HELD, and reporting those as
      "customers currently checking out" would show a manager phantom demand on a show that
      is actually quiet — precisely when they are deciding whether to open another screen.
    */
    const held = await this.prisma.showSeat.count({
      where: {
        eventSessionId: session.id,
        status: 'HELD',
        holdExpiresAt: { gt: now },
      },
    });

    const capacity = seatsTotal - gaps;
    // What the public could actually buy: capacity minus everything the house withheld.
    const sellable = Math.max(0, capacity - blocked);

    const sumFor = (status: BookingStatus) =>
      money
        .filter((m) => m.status === status)
        .reduce((sum, m) => sum + (m._sum.totalMinor ?? 0), 0);

    const blockedByKind = byKind
      .map((r) => ({
        kind: r.overrideKind as OverrideKind,
        label: OVERRIDE_LABEL[r.overrideKind as OverrideKind],
        count: r._count._all,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      sessionId: session.id,
      movieTitle: session.event.movie?.title ?? null,
      screenId: session.screen?.id ?? null,
      screenName: session.screen?.name ?? null,
      cinemaId: session.screen?.cinema.id ?? null,
      cinemaName: session.screen?.cinema.name ?? null,
      timezone: session.screen?.cinema.timezone ?? null,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      status: session.status,

      seatsTotal,
      capacity,
      sold,
      held,
      available,
      blocked,
      blockedByKind,
      house: blockedByKind.find((b) => b.kind === 'HOUSE')?.count ?? 0,

      occupancyPercent: sellable === 0 ? null : Math.round((sold / sellable) * 100),

      revenueMinor: sumFor(BookingStatus.CONFIRMED),
      pendingPaymentMinor: sumFor(BookingStatus.PENDING_PAYMENT),
      currency: money[0]?.currency ?? 'INR',
      salesPacePerHour: this.pace(sold, firstSale?.createdAt ?? null, now),
      observedAt: now,
    };
  }

  /**
   * Seats sold per hour since the first confirmed sale.
   *
   * Null below a few minutes of trading. Two sales in the first ninety seconds extrapolates
   * to eighty an hour, and a manager who opens a second screen on that number will regret it.
   */
  private pace(sold: number, firstSaleAt: Date | null, now: Date): number | null {
    if (sold === 0 || !firstSaleAt) return null;
    const hours = (now.getTime() - firstSaleAt.getTime()) / 3_600_000;
    if (hours < 0.25) return null;
    return Math.round((sold / hours) * 10) / 10;
  }

  // ── Live seat map ───────────────────────────────────────────────────────────────

  /**
   * Every seat of a show with its live state and any override.
   *
   * Reads the layout version PINNED TO THE SHOW via ShowSeat, so a screen that has since
   * been re-seated still renders the room this show is actually playing in.
   */
  async liveSeatMap(user: RequestUser, sessionId: string) {
    const session = await this.loadOwnedSession(user, sessionId);
    const now = new Date();

    const rows = await this.prisma.showSeat.findMany({
      where: { eventSessionId: sessionId },
      include: {
        seat: {
          select: {
            label: true,
            colIndex: true,
            kind: true,
            seatCategoryId: true,
            row: {
              select: {
                label: true,
                sortOrder: true,
                section: { select: { name: true, sortOrder: true } },
              },
            },
          },
        },
        overrideBy: { select: { fullName: true, email: true } },
      },
    });

    const categories = session.seatMapId
      ? await this.prisma.seatCategory.findMany({
          where: { seatMapId: session.seatMapId },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, name: true, colorHex: true, basePriceMinor: true },
        })
      : [];

    // Grouped into sections and rows so the client renders geometry rather than inventing it.
    const sections = new Map<
      string,
      {
        name: string;
        sortOrder: number;
        rows: Map<string, { label: string; sortOrder: number; seats: LiveSeat[] }>;
      }
    >();

    for (const r of rows) {
      const sectionName = r.seat.row.section.name;
      if (!sections.has(sectionName)) {
        sections.set(sectionName, {
          name: sectionName,
          sortOrder: r.seat.row.section.sortOrder,
          rows: new Map(),
        });
      }
      const section = sections.get(sectionName)!;
      const rowLabel = r.seat.row.label;
      if (!section.rows.has(rowLabel)) {
        section.rows.set(rowLabel, {
          label: rowLabel,
          sortOrder: r.seat.row.sortOrder,
          seats: [],
        });
      }
      section.rows.get(rowLabel)!.seats.push({
        seatId: r.seatId,
        label: `${rowLabel}${r.seat.label}`,
        row: rowLabel,
        colIndex: r.seat.colIndex,
        kind: r.seat.kind,
        categoryId: r.seat.seatCategoryId,
        status: r.status,
        overrideKind: r.overrideKind as OverrideKind | null,
        overrideReason: r.overrideReason,
        // A name, not a user id. An operator reading a seat map should see who blocked it.
        overrideBy: r.overrideBy?.fullName ?? r.overrideBy?.email ?? null,
        overrideAt: r.overrideAt,
        overrideExpiresAt: r.overrideExpiresAt,
        heldNow: r.status === 'HELD' && !!r.holdExpiresAt && r.holdExpiresAt > now,
      });
    }

    return {
      sessionId,
      movieTitle: session.event.movie?.title ?? null,
      screenName: session.screen?.name ?? null,
      cinemaName: session.screen?.cinema.name ?? null,
      timezone: session.screen?.cinema.timezone ?? null,
      startsAt: session.startsAt,
      status: session.status,
      seatMapId: session.seatMapId,
      categories,
      observedAt: now,
      sections: [...sections.values()]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((s) => ({
          name: s.name,
          rows: [...s.rows.values()]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((r) => ({
              label: r.label,
              seats: r.seats.sort((a, b) => a.colIndex - b.colIndex),
            })),
        })),
    };
  }

  // ── Reports ─────────────────────────────────────────────────────────────────────

  /**
   * Manual seat actions across a cinema and date range, newest first.
   *
   * Read from `AuditLog`, not reconstructed from current seat state. A seat blocked and then
   * released leaves no trace in `ShowSeat` at all, and a report that could not see it would
   * be useless for exactly the question it exists to answer.
   */
  async overrideReport(user: RequestUser, cinemaId: string, from: Date, to: Date) {
    const cinema = await this.prisma.cinema.findUnique({ where: { id: cinemaId } });
    if (!cinema) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Cinema not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, cinema.organizationId, ORGANIZER_ROLES);

    const screens = await this.prisma.screen.findMany({
      where: { cinemaId },
      select: { id: true, name: true },
    });
    const screenIds = new Set(screens.map((s) => s.id));
    const screenName = new Map(screens.map((s) => [s.id, s.name]));

    const entries = await this.prisma.auditLog.findMany({
      where: {
        organizationId: cinema.organizationId,
        entityType: 'EventSession',
        action: { in: ['SHOW_SEATS_BLOCKED', 'SHOW_SEATS_RELEASED', 'SHOW_SEATS_RELEASED_FORCED'] },
        createdAt: { gte: from, lte: to },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { actor: { select: { fullName: true, email: true } } },
    });

    // Tenancy is already established; this narrows an org-wide log to ONE cinema, which is
    // what the operator asked for.
    const scoped = entries.filter((e) => {
      const meta = (e.metadata ?? {}) as { screenId?: string };
      return meta.screenId ? screenIds.has(meta.screenId) : false;
    });

    const sessionIds = [...new Set(scoped.map((e) => e.entityId).filter(Boolean))] as string[];
    const sessions = await this.prisma.eventSession.findMany({
      where: { id: { in: sessionIds } },
      select: {
        id: true,
        startsAt: true,
        event: { select: { movie: { select: { title: true } } } },
      },
    });
    const sessionById = new Map(sessions.map((s) => [s.id, s]));

    const rows = scoped.map((e) => {
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      const session = e.entityId ? sessionById.get(e.entityId) : undefined;
      return {
        at: e.createdAt,
        action: e.action,
        actor: e.actor?.fullName ?? e.actor?.email ?? 'Unknown',
        sessionId: e.entityId,
        showStartsAt: session?.startsAt ?? null,
        movieTitle: session?.event.movie?.title ?? null,
        screenId: (meta.screenId as string) ?? null,
        screenName: meta.screenId ? (screenName.get(meta.screenId as string) ?? null) : null,
        kind: (meta.kind as OverrideKind) ?? null,
        housePurpose: (meta.housePurpose as string) ?? null,
        reason: (meta.reason as string) ?? null,
        seatCount: (meta.seatCount as number) ?? 0,
        seats: (meta.seats as string[]) ?? [],
        expiresAt: (meta.expiresAt as string) ?? null,
      };
    });

    const byKind = new Map<string, number>();
    const byReason = new Map<string, number>();
    const byActor = new Map<string, number>();
    for (const r of rows) {
      if (r.action === 'SHOW_SEATS_BLOCKED' && r.kind) {
        byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + r.seatCount);
      }
      if (r.reason) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + r.seatCount);
      byActor.set(r.actor, (byActor.get(r.actor) ?? 0) + r.seatCount);
    }

    const descending = (a: { count: number }, b: { count: number }) => b.count - a.count;
    return {
      cinemaId,
      from,
      to,
      totalActions: rows.length,
      seatsBlocked: rows
        .filter((r) => r.action === 'SHOW_SEATS_BLOCKED')
        .reduce((n, r) => n + r.seatCount, 0),
      seatsReleased: rows
        .filter((r) => r.action !== 'SHOW_SEATS_BLOCKED')
        .reduce((n, r) => n + r.seatCount, 0),
      byKind: [...byKind.entries()]
        .map(([kind, count]) => ({
          kind: kind as OverrideKind,
          label: OVERRIDE_LABEL[kind as OverrideKind],
          count,
        }))
        .sort(descending),
      byReason: [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort(descending),
      byOperator: [...byActor.entries()]
        .map(([actor, count]) => ({ actor, count }))
        .sort(descending),
      timeline: rows,
      /**
       * Whether the window was truncated. A silent cap reads as "that is all that happened",
       * which for an audit report is the one impression it must never give.
       */
      truncated: entries.length === 500,
    };
  }
}
