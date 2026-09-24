import { HttpStatus, Injectable } from '@nestjs/common';
import { FeedbackKind } from '@eticketsgo/shared-types';
import type {
  ListFeedbackInput,
  SubmitFeedbackInput,
  UpdateFeedbackInput,
} from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/** A support submission as surfaced to the admin triage inbox. */
export interface FeedbackRow {
  id: string;
  kind: string;
  status: string;
  email: string | null;
  subject: string | null;
  message: string;
  rating: number | null;
  metadata: Record<string, unknown> | null;
  userId: string | null;
  user: { email: string; fullName: string } | null;
  /** Which organizer this is about, where it is about one. Server-derived, never client-stated. */
  organizationId: string | null;
  organizationName: string | null;
  /** The booking complained about, by its public reference where it has one. */
  bookingId: string | null;
  bookingReference: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function paginate(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

@Injectable()
export class SupportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist a customer-success submission. Anonymous CONTACT submissions must
   * carry a reply-to email; signed-in callers have their id/email attached.
   */
  async submit(user: RequestUser | undefined, input: SubmitFeedbackInput) {
    const email = user?.email ?? input.email;
    if (input.kind === FeedbackKind.CONTACT && !email) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'An email address is required so we can reply.',
        HttpStatus.BAD_REQUEST,
        { fields: { email: ['An email address is required so we can reply.'] } },
      );
    }

    /*
      ── THE ORGANIZER IS DERIVED, NEVER DECLARED ──────────────────────────────────────
      A complaint names a booking; the platform looks up who sold it. Taking the organizer from
      the request would let anybody file complaints against a seller they never bought from, and
      the count an admin acts on - "six open complaints against this organizer" - would be
      something a stranger could inflate.

      An unknown booking id is not an error. Somebody mistyping a reference should still have
      their complaint recorded and read by a person; it is simply not attributed to a seller.
    */
    let organizationId: string | null = null;
    let bookingId: string | null = null;
    if (input.bookingId) {
      const booking = await this.prisma.booking.findUnique({
        where: { id: input.bookingId },
        select: { id: true, organizationId: true },
      });
      if (booking) {
        bookingId = booking.id;
        organizationId = booking.organizationId;
      }
    }

    const created = await this.prisma.feedback.create({
      data: {
        kind: input.kind,
        userId: user?.id ?? null,
        email: email ?? null,
        subject: input.subject ?? null,
        message: input.message,
        rating: input.rating ?? null,
        metadata: input.metadata ?? undefined,
        organizationId,
        bookingId,
        status: 'OPEN',
      },
      select: { id: true, status: true },
    });
    return created;
  }

  /**
   * How many complaints are open against one organizer, and how many there have ever been.
   *
   * Read by the admin console beside the suspend and delete controls, because "should this seller
   * keep selling" is the decision those controls are for, and it cannot be made without this.
   */
  async complaintCounts(organizationId: string) {
    const [open, total] = await Promise.all([
      this.prisma.feedback.count({
        where: { organizationId, kind: FeedbackKind.COMPLAINT, status: { not: 'CLOSED' } },
      }),
      this.prisma.feedback.count({
        where: { organizationId, kind: FeedbackKind.COMPLAINT },
      }),
    ]);
    return { open, total };
  }

  /** Paged, filterable admin triage list. Searches subject/message/email. */
  async list(
    params: ListFeedbackInput,
  ): Promise<{ data: FeedbackRow[]; meta: ReturnType<typeof paginate> }> {
    const where = {
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      ...(params.q
        ? {
            OR: [
              { message: { contains: params.q, mode: 'insensitive' as const } },
              { subject: { contains: params.q, mode: 'insensitive' as const } },
              { email: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.feedback.count({ where }),
      this.prisma.feedback.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { email: true, fullName: true } } },
      }),
    ]);

    /*
      Named in a second query, because `organizationId` carries no foreign key on purpose - the
      complaint outlives the organization. A row whose organization is gone shows its id, which is
      the only name left, rather than disappearing from the inbox.
    */
    const orgIds = [...new Set(rows.map((r) => r.organizationId).filter((v): v is string => !!v))];
    const bookingIds = [...new Set(rows.map((r) => r.bookingId).filter((v): v is string => !!v))];
    const [orgs, bookings] = await Promise.all([
      orgIds.length
        ? this.prisma.organization.findMany({
            where: { id: { in: orgIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      bookingIds.length
        ? this.prisma.booking.findMany({
            where: { id: { in: bookingIds } },
            select: { id: true, reference: true },
          })
        : Promise.resolve([]),
    ]);
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const bookingRef = new Map(bookings.map((b) => [b.id, b.reference]));

    return {
      data: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        email: r.email,
        subject: r.subject,
        message: r.message,
        rating: r.rating,
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
        userId: r.userId,
        user: r.user ? { email: r.user.email, fullName: r.user.fullName } : null,
        organizationId: r.organizationId,
        organizationName: r.organizationId
          ? (orgName.get(r.organizationId) ?? 'Deleted organization')
          : null,
        bookingId: r.bookingId,
        bookingReference: r.bookingId ? (bookingRef.get(r.bookingId) ?? null) : null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      meta: paginate(params.page, params.pageSize, total),
    };
  }

  /** Admin: advance a submission's triage status. */
  async updateStatus(id: string, input: UpdateFeedbackInput) {
    const existing = await this.prisma.feedback.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Feedback not found.', HttpStatus.NOT_FOUND);
    }
    return this.prisma.feedback.update({
      where: { id },
      data: { status: input.status },
      select: { id: true, status: true },
    });
  }
}
