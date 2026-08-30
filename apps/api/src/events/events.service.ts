import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { EventStatus, Role, NotificationType } from '@eticketsgo/shared-types';
import type {
  CreateEventInput,
  CreateSessionInput,
  CreateTicketTypeInput,
  UpdateTicketTypeInput,
  ReviewDecisionInput,
} from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AdminAudienceService } from '../notifications/admin-audience.service';
import { AppException, ErrorCodes } from '../common/errors';
import { ShowsService } from '../shows/shows.service';
import type { RequestUser } from '../common/decorators';

const ORGANIZER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

function paginate(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

function slugify(title: string): string {
  return `${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}-${randomBytes(3).toString('hex')}`;
}

/**
 * A free event's ticket types must cost nothing.
 *
 * Guarded here rather than left to the organizer's care because the booking path trusts the
 * flag: a free event's booking skips the payment provider entirely. A priced ticket type on
 * a free event would therefore be given away, and the discrepancy would only surface in the
 * takings. Refused at the point of entry, where the person who typed the price is still
 * looking at the screen.
 */
function assertPriceFitsEvent(isFree: boolean, priceMinor: number) {
  if (isFree && priceMinor !== 0) {
    throw new AppException(
      ErrorCodes.CONFLICT,
      'This is a free event, so its tickets must be priced at zero. Turn off the free-event setting to charge for it.',
      HttpStatus.CONFLICT,
      { priceMinor },
    );
  }
}

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
    private readonly audience: AdminAudienceService,
    private readonly config: ConfigService,
    /*
      Seating a session is the same work cinema scheduling does, so it is the same code.
      ShowsModule does not import EventsModule, so this direction introduces no cycle.
    */
    private readonly shows: ShowsService,
  ) {}

  /** First configured web origin, trailing slash trimmed (mirrors sharing.service). */
  private siteBaseUrl(): string {
    const origins = this.config.get<string>('CORS_ORIGINS') ?? 'http://localhost:3000';
    return origins.split(',')[0].trim().replace(/\/$/, '');
  }

  private async loadOwnedEvent(user: RequestUser, id: string, roles = ORGANIZER_ROLES) {
    const event = await this.prisma.event.findUnique({ where: { id } });
    if (!event)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, event.organizationId, roles);
    return event;
  }

  async create(user: RequestUser, organizationId: string, input: CreateEventInput) {
    await this.access.assertMember(user, organizationId, ORGANIZER_ROLES);
    const venue = await this.prisma.venue.findUnique({ where: { id: input.venueId } });
    if (!venue || venue.organizationId !== organizationId) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Venue not found for this organization.',
        HttpStatus.NOT_FOUND,
      );
    }
    const event = await this.prisma.event.create({
      data: {
        organizationId,
        venueId: input.venueId,
        title: input.title,
        slug: slugify(input.title),
        category: input.category,
        description: input.description,
        refundPolicy: input.refundPolicy,
        feeMode: input.feeMode,
        isFree: input.isFree,
        status: EventStatus.DRAFT,
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId,
      action: 'EVENT_CREATED',
      entityType: 'Event',
      entityId: event.id,
    });
    return event;
  }

  /**
   * Duplicate an event into a fresh DRAFT: copies the event's settings, its sessions,
   * and each session's ticket types (with brand-new, empty inventory). Deliberately
   * excludes orders, attendees, payments, and audit history (those belong to the
   * original). Coupons are organization-scoped (not event-bound) and images are not
   * modelled on events, so neither needs copying.
   */
  async duplicate(user: RequestUser, eventId: string) {
    const original = await this.loadOwnedEvent(user, eventId);
    const sessions = await this.prisma.eventSession.findMany({
      where: { eventId },
      orderBy: { startsAt: 'asc' },
      include: { ticketTypes: true },
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const copy = await tx.event.create({
        data: {
          organizationId: original.organizationId,
          venueId: original.venueId,
          experienceType: original.experienceType,
          movieId: original.movieId,
          title: `${original.title} (Copy)`,
          slug: slugify(`${original.title}-copy`),
          category: original.category,
          description: original.description,
          feeMode: original.feeMode,
          isFree: original.isFree,
          refundPolicy: original.refundPolicy,
          status: EventStatus.DRAFT,
        },
      });
      for (const s of sessions) {
        const newSession = await tx.eventSession.create({
          data: {
            eventId: copy.id,
            screenId: s.screenId,
            startsAt: s.startsAt,
            endsAt: s.endsAt,
          },
        });
        for (const t of s.ticketTypes) {
          await tx.ticketType.create({
            data: {
              eventSessionId: newSession.id,
              seatCategoryId: t.seatCategoryId,
              name: t.name,
              priceMinor: t.priceMinor,
              currency: t.currency,
              quantityTotal: t.quantityTotal,
              maxPerOrder: t.maxPerOrder,
              salesStartAt: t.salesStartAt,
              salesEndAt: t.salesEndAt,
              status: t.status,
              // Fresh inventory — none of the original's sales/holds carry over.
              inventory: { create: { quantityTotal: t.quantityTotal } },
            },
          });
        }
      }
      return copy;
    });

    await this.audit.record({
      actorUserId: user.id,
      organizationId: original.organizationId,
      action: 'EVENT_DUPLICATED',
      entityType: 'Event',
      entityId: created.id,
      metadata: { sourceEventId: eventId, sessions: sessions.length },
    });
    return created;
  }

  /**
   * Marketing assets for an event: its public URL plus a QR code (data URL) that
   * resolves to that page. Reuses the `qrcode` dependency already used for tickets;
   * the front-end builds share links and posters from these two values.
   */
  async promotion(user: RequestUser, eventId: string) {
    const event = await this.loadOwnedEvent(user, eventId);
    const publicUrl = `${this.siteBaseUrl()}/events/${event.slug}`;
    const qrDataUrl = await QRCode.toDataURL(publicUrl, { margin: 1, width: 512 });
    return {
      eventId: event.id,
      title: event.title,
      slug: event.slug,
      published: event.status === EventStatus.PUBLISHED,
      publicUrl,
      qrDataUrl,
    };
  }

  async update(user: RequestUser, id: string, patch: Partial<CreateEventInput>) {
    const event = await this.loadOwnedEvent(user, id);
    const editable: EventStatus[] = [
      EventStatus.DRAFT,
      EventStatus.UNDER_REVIEW,
      EventStatus.PAUSED,
    ];
    if (!editable.includes(event.status as EventStatus)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `An event in status ${event.status} cannot be edited.`,
        HttpStatus.CONFLICT,
      );
    }
    /*
      Turning the free flag over is a change of financial contract, so it is checked against
      what has already happened rather than just written.

      Turning free ON with priced tickets on file would let a buyer walk past a charge that
      the ticket types still advertise. Turning it OFF once free bookings exist would leave
      confirmed bookings with no Payment row inside an event the rest of the system now reads
      as paid — reconciliation would be looking for money that was never owed. Both are
      refused with the reason, so the organizer can fix the prices or the event and retry.
    */
    if (patch.isFree !== undefined && patch.isFree !== event.isFree) {
      const bookings = await this.prisma.booking.count({ where: { eventId: id } });
      if (bookings > 0) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          'This event already has bookings, so it cannot be switched between free and paid.',
          HttpStatus.CONFLICT,
          { bookings },
        );
      }
      if (patch.isFree) {
        const priced = await this.prisma.ticketType.count({
          where: { eventSession: { eventId: id }, priceMinor: { not: 0 } },
        });
        if (priced > 0) {
          throw new AppException(
            ErrorCodes.CONFLICT,
            `Set all ${priced} priced ticket type${priced === 1 ? '' : 's'} to zero before making this event free.`,
            HttpStatus.CONFLICT,
            { pricedTicketTypes: priced },
          );
        }
      }
    }
    return this.prisma.event.update({ where: { id }, data: patch });
  }

  async listForOrg(user: RequestUser, organizationId: string) {
    await this.access.assertMember(user, organizationId);
    return this.prisma.event.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: {
        venue: { select: { name: true, city: true } },
        _count: { select: { sessions: true, bookings: true } },
      },
    });
  }

  async getForOrg(user: RequestUser, id: string) {
    const event = await this.loadOwnedEvent(user, id);
    return this.prisma.event.findUnique({
      where: { id: event.id },
      include: {
        venue: true,
        sessions: {
          orderBy: { startsAt: 'asc' },
          include: {
            ticketTypes: { include: { inventory: true }, orderBy: { priceMinor: 'asc' } },
            // So the schedule can say WHICH room a seated session is in. `screenId` alone
            // tells the organizer only that it is seated somewhere, which is the half of the
            // answer they already knew.
            screen: { select: { name: true, cinema: { select: { name: true } } } },
          },
        },
      },
    });
  }

  /** Organizer view of bookings (orders) for an event. */
  async orders(
    user: RequestUser,
    eventId: string,
    params: { page: number; pageSize: number; status?: string; q?: string },
  ) {
    await this.loadOwnedEvent(user, eventId);
    const where = {
      eventId,
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { buyerName: { contains: params.q, mode: 'insensitive' as const } },
              { buyerEmail: { contains: params.q, mode: 'insensitive' as const } },
              { reference: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, bookings] = await this.prisma.$transaction([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { payment: { select: { status: true } }, _count: { select: { tickets: true } } },
      }),
    ]);
    return {
      data: bookings.map((b) => ({
        id: b.id,
        reference: b.reference,
        status: b.status,
        buyerName: b.buyerName,
        buyerEmail: b.buyerEmail,
        totalMinor: b.totalMinor,
        createdAt: b.createdAt,
        ticketCount: b._count.tickets,
        paymentStatus: b.payment?.status ?? null,
      })),
      meta: paginate(params.page, params.pageSize, total),
    };
  }

  /** Organizer view of attendees (issued tickets) for an event. */
  async attendees(
    user: RequestUser,
    eventId: string,
    params: { page: number; pageSize: number; status?: string; q?: string; sessionId?: string },
  ) {
    await this.loadOwnedEvent(user, eventId);
    const where = {
      eventSession: { eventId },
      ...(params.sessionId ? { eventSessionId: params.sessionId } : {}),
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { holderName: { contains: params.q, mode: 'insensitive' as const } },
              { holderEmail: { contains: params.q, mode: 'insensitive' as const } },
              { serial: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, tickets] = await this.prisma.$transaction([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          ticketType: { select: { name: true } },
          eventSession: { select: { startsAt: true } },
          checkIns: {
            where: { result: 'SUCCESS', reversed: false },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { createdAt: true },
          },
        },
      }),
    ]);
    return {
      data: tickets.map((t) => ({
        id: t.id,
        serial: t.serial,
        status: t.status,
        holderName: t.holderName,
        holderEmail: t.holderEmail,
        ticketType: t.ticketType.name,
        sessionStartsAt: t.eventSession.startsAt,
        checkedInAt: t.checkIns[0]?.createdAt ?? null,
      })),
      meta: paginate(params.page, params.pageSize, total),
    };
  }

  /**
   * The rooms an event could be seated in.
   *
   * Deliberately answers with only what `addSession` would ACCEPT — rooms in this
   * organization, each with a published layout — rather than every room it owns.
   * A picker that offers a choice the next request refuses teaches the organizer that the
   * product is broken, when the real answer is "that room has no seat map yet", and they
   * would have to guess which of the two rules they tripped.
   *
   * The seat count is the number of seats that can actually be SOLD, so aisles and gaps are
   * excluded: a room drawn as twenty-four positions with two aisle columns seats twenty, and
   * twenty is the number the organizer is choosing between rooms on.
   */
  async listSeatingRooms(user: RequestUser, organizationId: string) {
    /*
      Scoped to the ORGANIZATION rather than to an event, because the event does not exist
      yet at the moment the question is first asked — the create wizard needs the list on the
      step where sessions are chosen, before anything has been saved.
    */
    await this.access.assertMember(user, organizationId, ORGANIZER_ROLES);

    const screens = await this.prisma.screen.findMany({
      where: {
        cinema: { organizationId },
        seatMaps: { some: { status: 'PUBLISHED' } },
      },
      select: {
        id: true,
        name: true,
        cinema: { select: { name: true } },
        seatMaps: {
          where: { status: 'PUBLISHED' },
          /*
            The newest published version, by version number rather than by `effectiveFrom` —
            that column is nullable ("live as soon as it was published") and Postgres sorts
            nulls first on a descending sort, so ordering by it would rank an older
            undated layout above the dated one that supersedes it. Version is monotonic
            per screen, so it has no such gap.

            Which version a session ACTUALLY gets is still decided at creation time from its
            start time, because a room can have a layout scheduled to take effect later. This
            is the room's current shape, which is what somebody choosing between rooms needs.
          */
          orderBy: { version: 'desc' },
          take: 1,
          select: {
            id: true,
            name: true,
            layoutKind: true,
            _count: { select: { seats: { where: { kind: { not: 'GAP' } } } } },
          },
        },
      },
      orderBy: [{ cinema: { name: 'asc' } }, { name: 'asc' }],
    });

    return screens
      .filter((s) => s.seatMaps[0])
      .map((s) => ({
        id: s.id,
        name: s.name,
        venueName: s.cinema.name,
        layoutName: s.seatMaps[0].name,
        layoutKind: s.seatMaps[0].layoutKind,
        sellableSeats: s.seatMaps[0]._count.seats,
      }));
  }

  /**
   * Add a session, optionally in a room with a seat map.
   *
   * ── WHAT A ROOM CHANGES ────────────────────────────────────────────────────────────
   * Naming one makes the session reserved seating: buyers pick named seats and each ticket
   * is bound to one. Leaving it off keeps the session general admission. That is the whole
   * difference, and it is a fact about the room rather than about the kind of event.
   *
   * Two things are checked before it is accepted, because both failures are otherwise found
   * by a customer rather than by the organizer: the room has to belong to this organization,
   * and it has to have a published layout. A session in a room with no seat map is one where
   * nobody can choose a seat, and the error would surface at the moment of sale.
   */
  async addSession(user: RequestUser, eventId: string, input: CreateSessionInput) {
    const event = await this.loadOwnedEvent(user, eventId);

    // Same two rules `updateSessionSeating` applies, from one implementation — a room that
    // is acceptable when a session is created must stay acceptable when it is changed.
    if (input.screenId) {
      await this.assertRoomIsUsable(input.screenId, event.organizationId);
    }

    if (!input.screenId) {
      return this.prisma.eventSession.create({
        data: { eventId, startsAt: input.startsAt, endsAt: input.endsAt },
      });
    }

    /*
      A seated session is created with its seats, in one transaction.

      The layout is resolved for THIS session's start time rather than "the room's map" —
      a room can have a new layout scheduled to take effect, and a session must use the one
      that will be in force when its doors open.

      `seatSession` is the same call cinema scheduling makes. Sharing it is deliberate: when
      this logic existed twice, the fix for the platform selling AISLE POSITIONS as seats had
      to be applied at both sites, and the second was found by accident.
    */
    const screenId = input.screenId;
    const seatMap = await this.shows.resolveLayoutForShow(screenId, input.startsAt);
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.eventSession.create({
        data: {
          eventId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          screenId,
          // Pin the version, so the schedule can say which room this uses before a seat has
          // been touched, and so a later layout change cannot rewrite a session already sold.
          seatMapId: seatMap.id,
        },
      });
      await this.shows.seatSession(tx, session.id, seatMap);
      return session;
    });
  }

  /**
   * Change, add or remove a session's room — while nothing has been sold.
   *
   * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
   * Seating was originally chosen only when a session was created, on the reasoning that
   * re-seating a session with sold tickets is a refund question rather than a settings
   * change. That reasoning is sound and it still holds — but it was applied to every
   * session, including the overwhelming majority that have sold nothing at all.
   *
   * The result was an organizer creating an event, realising it should have assigned
   * seating, and finding no way to say so: the only route was to delete the session and
   * build it again. For a draft nobody has bought from, that is an obstacle with no
   * safety argument behind it.
   *
   * ── WHAT MAKES IT SAFE ─────────────────────────────────────────────────────────────
   * One rule, checked in the transaction: nothing may be sold OR HELD. Held matters as
   * much as sold — a hold is somebody at a checkout right now, and re-seating underneath
   * them would take the seat they are paying for. Past that line the answer is a refusal
   * that names the reason, because "you can't" without "because two tickets are sold" is
   * indistinguishable from a broken button.
   *
   * Ticket types are REPLACED, not merged. A seated session derives one per seat category
   * and a general-admission one carries whatever was typed; keeping both would leave two
   * competing prices on the same night. Nothing is sold, so a ticket type here is draft
   * configuration rather than a commitment — but the caller is told the count first, so
   * the organizer confirms the loss rather than discovering it.
   */
  async updateSessionSeating(user: RequestUser, sessionId: string, screenId: string | null) {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: sessionId },
      include: { event: { select: { id: true, organizationId: true } } },
    });
    if (!session) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Session not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, session.event.organizationId, ORGANIZER_ROLES);

    await this.assertNothingCommitted(sessionId);

    if (screenId) {
      await this.assertRoomIsUsable(screenId, session.event.organizationId);
    }

    /*
      Validated and resolved BEFORE the transaction opens, for the error message rather than
      for safety. A refusal raised inside would still roll back cleanly — Postgres sees to
      that, and the test asserts it — so nothing can be half-changed either way.

      What the ordering buys is WHICH check speaks first. `resolveLayoutForShow` is the
      cinema scheduler's own lookup and it fails with "generate one before scheduling shows",
      which is the wrong vocabulary for somebody adding seats to a concert and does not say
      the layout has to be PUBLISHED. Running the room check first means an organizer is told
      what to actually do. It also keeps a multi-query read outside an open transaction.
    */
    const seatMap = screenId
      ? await this.shows.resolveLayoutForShow(screenId, session.startsAt)
      : null;

    return this.prisma.$transaction(async (tx) => {
      // Re-checked inside the transaction. The check above gives a good error message; this
      // one closes the window between reading and writing, where a booking can land.
      await this.assertNothingCommitted(sessionId, tx);

      await tx.showSeat.deleteMany({ where: { eventSessionId: sessionId } });
      // Inventory first — it holds the foreign key.
      await tx.ticketInventory.deleteMany({ where: { ticketType: { eventSessionId: sessionId } } });
      await tx.ticketType.deleteMany({ where: { eventSessionId: sessionId } });

      const updated = await tx.eventSession.update({
        where: { id: sessionId },
        data: { screenId: screenId ?? null, seatMapId: seatMap?.id ?? null },
      });
      if (seatMap) await this.shows.seatSession(tx, sessionId, seatMap);
      return updated;
    });
  }

  /**
   * Refuse once anything is sold or held, and say which.
   *
   * Counts bookings as well as inventory: a booking exists from the moment somebody starts
   * checking out, before any inventory number moves, and it is the earliest signal that a
   * real person is depending on this session's seats.
   */
  private async assertNothingCommitted(
    sessionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;

    const bookings = await db.booking.count({
      where: { eventSessionId: sessionId, status: { notIn: ['CANCELLED', 'EXPIRED'] } },
    });
    if (bookings > 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Seating cannot be changed: this session already has ${bookings} booking${
          bookings === 1 ? '' : 's'
        }. Changing the room would move seats people have already paid for.`,
        HttpStatus.CONFLICT,
        { sessionId, bookings },
      );
    }

    const committed = await db.ticketInventory.aggregate({
      where: { ticketType: { eventSessionId: sessionId } },
      _sum: { quantitySold: true, quantityHeld: true },
    });
    const sold = committed._sum.quantitySold ?? 0;
    const held = committed._sum.quantityHeld ?? 0;
    if (sold > 0 || held > 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Seating cannot be changed: ${sold} ticket${sold === 1 ? '' : 's'} sold and ${held} ` +
          `currently held for this session.`,
        HttpStatus.CONFLICT,
        { sessionId, sold, held },
      );
    }
  }

  /** The room belongs to this organization and has a published layout. Shared with addSession. */
  private async assertRoomIsUsable(screenId: string, organizationId: string): Promise<void> {
    const screen = await this.prisma.screen.findUnique({
      where: { id: screenId },
      select: {
        id: true,
        cinema: { select: { organizationId: true } },
        seatMaps: { where: { status: 'PUBLISHED' }, select: { id: true }, take: 1 },
      },
    });
    if (!screen || screen.cinema.organizationId !== organizationId) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Room not found for this organization.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (screen.seatMaps.length === 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'That room has no published seat map yet, so nobody could choose a seat. Publish a layout for it first.',
        HttpStatus.CONFLICT,
        { screenId },
      );
    }
  }

  async addTicketType(user: RequestUser, input: CreateTicketTypeInput) {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: input.eventSessionId },
      include: { event: true },
    });
    if (!session) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Session not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user, session.event.organizationId, ORGANIZER_ROLES);
    assertPriceFitsEvent(session.event.isFree, input.priceMinor);
    return this.prisma.ticketType.create({
      data: {
        eventSessionId: input.eventSessionId,
        name: input.name,
        priceMinor: input.priceMinor,
        currency: input.currency,
        quantityTotal: input.quantityTotal,
        maxPerOrder: input.maxPerOrder,
        salesStartAt: input.salesStartAt,
        salesEndAt: input.salesEndAt,
        inventory: { create: { quantityTotal: input.quantityTotal } },
      },
      include: { inventory: true },
    });
  }

  /** Load a ticket type with its inventory + owning org, and assert organizer access. */
  private async loadOwnedTicketType(user: RequestUser, id: string) {
    const tt = await this.prisma.ticketType.findUnique({
      where: { id },
      include: { inventory: true, eventSession: { include: { event: true } } },
    });
    if (!tt)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Ticket type not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, tt.eventSession.event.organizationId, ORGANIZER_ROLES);
    return tt;
  }

  /**
   * Edit a ticket type with sales-safety rules: the price is locked once any ticket
   * has sold (changing a paid price is a financial-integrity risk), and the quantity
   * can only rise to at least the already-committed (sold + held) amount — it can
   * never drop below what buyers already hold. Name/limits/window/status are free.
   */
  async updateTicketType(user: RequestUser, id: string, input: UpdateTicketTypeInput) {
    const tt = await this.loadOwnedTicketType(user, id);
    if (input.priceMinor !== undefined) {
      assertPriceFitsEvent(tt.eventSession.event.isFree, input.priceMinor);
    }
    const committed = (tt.inventory?.quantitySold ?? 0) + (tt.inventory?.quantityHeld ?? 0);
    const sold = tt.inventory?.quantitySold ?? 0;

    if (input.priceMinor !== undefined && input.priceMinor !== tt.priceMinor && sold > 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Price cannot be changed after tickets have sold.',
        HttpStatus.CONFLICT,
      );
    }
    if (input.quantityTotal !== undefined && input.quantityTotal < committed) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Quantity cannot be below the ${committed} already sold/held.`,
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.ticketType.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        priceMinor: input.priceMinor ?? undefined,
        maxPerOrder: input.maxPerOrder ?? undefined,
        status: input.status ?? undefined,
        salesStartAt: input.salesStartAt === undefined ? undefined : input.salesStartAt,
        salesEndAt: input.salesEndAt === undefined ? undefined : input.salesEndAt,
        quantityTotal: input.quantityTotal ?? undefined,
        ...(input.quantityTotal !== undefined
          ? { inventory: { update: { quantityTotal: input.quantityTotal } } }
          : {}),
      },
      include: { inventory: true },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: tt.eventSession.event.organizationId,
      action: 'TICKET_TYPE_UPDATED',
      entityType: 'TicketType',
      entityId: id,
      metadata: { ...input, salesStartAt: undefined, salesEndAt: undefined },
    });
    return updated;
  }

  /** Delete a ticket type only when nothing has been sold or held against it. */
  async deleteTicketType(user: RequestUser, id: string) {
    const tt = await this.loadOwnedTicketType(user, id);
    if ((tt.inventory?.quantitySold ?? 0) > 0 || (tt.inventory?.quantityHeld ?? 0) > 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This ticket type has sales/holds and cannot be deleted. Deactivate it instead.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction([
      this.prisma.ticketInventory.deleteMany({ where: { ticketTypeId: id } }),
      this.prisma.ticketType.delete({ where: { id } }),
    ]);
    await this.audit.record({
      actorUserId: user.id,
      organizationId: tt.eventSession.event.organizationId,
      action: 'TICKET_TYPE_DELETED',
      entityType: 'TicketType',
      entityId: id,
      metadata: { name: tt.name },
    });
    return { ok: true };
  }

  async submitForReview(user: RequestUser, id: string) {
    const event = await this.loadOwnedEvent(user, id);
    const submittable: EventStatus[] = [EventStatus.DRAFT, EventStatus.PAUSED];
    if (!submittable.includes(event.status as EventStatus)) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Only draft events can be submitted for review (current: ${event.status}).`,
        HttpStatus.CONFLICT,
      );
    }
    const sessionCount = await this.prisma.eventSession.count({ where: { eventId: id } });
    const ticketCount = await this.prisma.ticketType.count({
      where: { eventSession: { eventId: id } },
    });
    if (sessionCount === 0 || ticketCount === 0) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Add at least one session and ticket type before submitting for review.',
        HttpStatus.CONFLICT,
      );
    }
    const org = await this.prisma.organization.findUnique({
      where: { id: event.organizationId },
      select: { name: true, status: true, autoApproveEvents: true },
    });

    /*
      Trusted organizers skip the queue.

      "It is hard to approve each and every event — let's have a toggle on the orgs, auto
      approve if we are getting an event from trusted orgs." Review exists because a new
      organizer can list anything, and by the time somebody notices a ticket has been sold.
      That cost is worth paying once; paying it on the two-hundredth event from a cinema
      chain that has never had one rejected is just a delay.

      A SUSPENDED organization never auto-approves whatever the flag says. Suspension is the
      platform withdrawing trust, and a stale flag must not outrank a live decision.
    */
    const autoApprove = Boolean(org?.autoApproveEvents) && org?.status !== 'SUSPENDED';

    const updated = await this.prisma.event.update({
      where: { id },
      data: autoApprove
        ? { status: EventStatus.PUBLISHED, publishedAt: new Date(), reviewNote: null }
        : { status: EventStatus.UNDER_REVIEW },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: event.organizationId,
      // Auditied under its own action, never as an approval by the submitting organizer.
      // An admin asking "what went live without review?" needs a term to search for.
      action: autoApprove ? 'EVENT_AUTO_APPROVED' : 'EVENT_SUBMITTED_FOR_REVIEW',
      entityType: 'Event',
      entityId: id,
    });

    if (autoApprove) {
      // The organizer is told it is live, in the same words a reviewer's approval uses —
      // from their side the outcome is identical, and inventing a second vocabulary for it
      // would only raise the question of what the difference is.
      await this.audience.notifyOrganizationOwners(
        event.organizationId,
        NotificationType.EVENT_APPROVED,
        { eventId: id, eventTitle: updated.title, reason: '' },
      );
      return updated;
    }

    /*
      Page the reviewers. An event sitting in UNDER_REVIEW cannot sell a ticket, and until
      now nothing told an admin it was there — the organizer's launch date depended on
      somebody happening to open the admin queue.
    */
    await this.audience.notifyAdmins(NotificationType.EVENT_SUBMITTED, {
      eventId: id,
      eventTitle: updated.title,
      organizationId: event.organizationId,
      organizationName: org?.name ?? 'An organizer',
      submittedByUserId: user.id,
    });

    return updated;
  }

  async setPaused(user: RequestUser, id: string, paused: boolean) {
    const event = await this.loadOwnedEvent(user, id);
    const target = paused ? EventStatus.PAUSED : EventStatus.PUBLISHED;
    const from = paused ? EventStatus.PUBLISHED : EventStatus.PAUSED;
    if (event.status !== from) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Cannot ${paused ? 'pause' : 'resume'} an event in status ${event.status}.`,
        HttpStatus.CONFLICT,
      );
    }
    return this.prisma.event.update({ where: { id }, data: { status: target } });
  }

  // ─── Admin ───

  async adminList(status: EventStatus | undefined, page: number, pageSize: number) {
    const where = status ? { status } : {};
    const [total, data] = await this.prisma.$transaction([
      this.prisma.event.count({ where }),
      this.prisma.event.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { updatedAt: 'desc' },
        include: {
          organization: { select: { name: true } },
          venue: { select: { name: true, city: true } },
        },
      }),
    ]);
    return { data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }

  async review(admin: RequestUser, id: string, input: ReviewDecisionInput) {
    const event = await this.prisma.event.findUnique({ where: { id } });
    if (!event)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
    if (event.status !== EventStatus.UNDER_REVIEW) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `Only events under review can be decided (current: ${event.status}).`,
        HttpStatus.CONFLICT,
      );
    }
    const approve = input.decision === 'APPROVE';
    const updated = await this.prisma.event.update({
      where: { id },
      data: {
        status: approve ? EventStatus.PUBLISHED : EventStatus.DRAFT,
        publishedAt: approve ? new Date() : null,
        reviewedByUserId: admin.id,
        reviewNote: input.note,
      },
    });
    await this.audit.record({
      actorUserId: admin.id,
      organizationId: event.organizationId,
      action: approve ? 'EVENT_APPROVED' : 'EVENT_REJECTED',
      entityType: 'Event',
      entityId: id,
      metadata: { note: input.note },
    });

    /*
      And tell the organizer the outcome. A rejection carries the reviewer's note, because
      "not approved" on its own gives them nothing to change and turns into a support
      ticket asking what to fix.
    */
    await this.audience.notifyOrganizationOwners(
      event.organizationId,
      approve ? NotificationType.EVENT_APPROVED : NotificationType.EVENT_REJECTED,
      { eventId: id, eventTitle: updated.title, reason: input.note ?? '' },
    );

    return updated;
  }

  async adminSetStatus(admin: RequestUser, id: string, status: EventStatus) {
    const event = await this.prisma.event.findUnique({ where: { id } });
    if (!event)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Event not found.', HttpStatus.NOT_FOUND);
    const updated = await this.prisma.event.update({ where: { id }, data: { status } });
    await this.audit.record({
      actorUserId: admin.id,
      organizationId: event.organizationId,
      action: 'EVENT_STATUS_CHANGED',
      entityType: 'Event',
      entityId: id,
      metadata: { status },
    });
    return updated;
  }

  /**
   * Retires live events whose last session has ended. Invoked by the worker so
   * the catalogue and reporting reflect reality without manual intervention.
   */
  async completePastEvents(): Promise<number> {
    const now = new Date();
    const live: EventStatus[] = [EventStatus.PUBLISHED, EventStatus.PAUSED, EventStatus.SOLD_OUT];
    const candidates = await this.prisma.event.findMany({
      where: { status: { in: live } },
      select: {
        id: true,
        sessions: { select: { endsAt: true }, orderBy: { endsAt: 'desc' }, take: 1 },
      },
    });
    const toComplete = candidates
      .filter((e) => e.sessions[0] && e.sessions[0].endsAt < now)
      .map((e) => e.id);
    if (toComplete.length === 0) return 0;
    await this.prisma.event.updateMany({
      where: { id: { in: toComplete } },
      data: { status: EventStatus.COMPLETED },
    });
    return toComplete.length;
  }
}
