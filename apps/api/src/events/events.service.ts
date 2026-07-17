import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { EventStatus, Role } from '@eticketsgo/shared-types';
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
import { AppException, ErrorCodes } from '../common/errors';
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

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

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

  async addSession(user: RequestUser, eventId: string, input: CreateSessionInput) {
    await this.loadOwnedEvent(user, eventId);
    return this.prisma.eventSession.create({
      data: { eventId, startsAt: input.startsAt, endsAt: input.endsAt },
    });
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
    const updated = await this.prisma.event.update({
      where: { id },
      data: { status: EventStatus.UNDER_REVIEW },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: event.organizationId,
      action: 'EVENT_SUBMITTED_FOR_REVIEW',
      entityType: 'Event',
      entityId: id,
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
