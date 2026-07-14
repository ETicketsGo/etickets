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

    const created = await this.prisma.feedback.create({
      data: {
        kind: input.kind,
        userId: user?.id ?? null,
        email: email ?? null,
        subject: input.subject ?? null,
        message: input.message,
        rating: input.rating ?? null,
        metadata: input.metadata ?? undefined,
        status: 'OPEN',
      },
      select: { id: true, status: true },
    });
    return created;
  }

  /** Paged, filterable admin triage list. Searches subject/message/email. */
  async list(
    params: ListFeedbackInput,
  ): Promise<{ data: FeedbackRow[]; meta: ReturnType<typeof paginate> }> {
    const where = {
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.status ? { status: params.status } : {}),
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
