import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  Role,
  canResolveReconcile,
  type ReconcileOutcome,
  type ReconcileResolutionAction,
  type ReconcileReviewState,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';

const STAFF_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];
const MANAGER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export interface ReconciliationFilters {
  organizationId: string;
  eventId?: string;
  eventSessionId?: string;
  deviceId?: string;
  outcome?: string;
  reviewState?: string;
  ticketId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Read + safe-resolution service for the Reconciliation Console (ADR-035). Reads the
 * durable reconciliation ledger with production-safe filters + pagination, and lets a
 * manager/admin resolve ONLY a still-pending supervisor-review case — an audit-only
 * annotation that never changes the outcome or admits a ticket.
 */
@Injectable()
export class OfflineReconciliationConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(user: RequestUser, filters: ReconciliationFilters) {
    await this.access.assertMember(user, filters.organizationId, STAFF_ROLES);

    const page = Math.max(1, Math.floor(filters.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
    );

    const where: Prisma.OfflineReconciliationRecordWhereInput = {
      organizationId: filters.organizationId,
      ...(filters.eventId ? { eventId: filters.eventId } : {}),
      ...(filters.eventSessionId ? { eventSessionId: filters.eventSessionId } : {}),
      ...(filters.deviceId ? { deviceId: filters.deviceId } : {}),
      ...(filters.outcome ? { outcome: filters.outcome } : {}),
      ...(filters.reviewState ? { reviewState: filters.reviewState as ReconcileReviewState } : {}),
      ...(filters.ticketId ? { ticketId: { contains: filters.ticketId } } : {}),
      ...(filters.from || filters.to
        ? {
            reconciledAt: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.offlineReconciliationRecord.count({ where }),
      this.prisma.offlineReconciliationRecord.findMany({
        where,
        orderBy: { reconciledAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // Resolve operator / resolver emails in one batched query (no User relation churn).
    const userIds = [
      ...new Set(
        rows.flatMap((r) => [r.operatorUserId, r.resolvedByUserId]).filter((v): v is string => !!v),
      ),
    ];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, fullName: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    const data = rows.map((r) => ({
      ...r,
      operator: r.operatorUserId ? (byId.get(r.operatorUserId) ?? null) : null,
      resolvedBy: r.resolvedByUserId ? (byId.get(r.resolvedByUserId) ?? null) : null,
    }));

    return { data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }

  /**
   * Resolves a supervisor-review record. Manager/admin-only, requires a reason, fully
   * audited. Only a PENDING review-required case with a permitted (audit-only) action
   * may be resolved — the outcome is never changed and no ticket is ever admitted here.
   */
  async resolve(user: RequestUser, id: string, action: ReconcileResolutionAction, reason: string) {
    const record = await this.prisma.offlineReconciliationRecord.findUnique({ where: { id } });
    if (!record) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Reconciliation record not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.access.assertMember(user, record.organizationId, MANAGER_ROLES);

    if (!reason?.trim()) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'A reason is required to resolve a reconciliation case.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      !canResolveReconcile(
        record.outcome as ReconcileOutcome,
        record.reviewState as ReconcileReviewState,
        action,
      )
    ) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This record cannot be resolved with that action (only a pending supervisor-review case allows an audit-only ACKNOWLEDGE/DISMISS).',
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.offlineReconciliationRecord.update({
      where: { id },
      data: {
        reviewState: 'RESOLVED',
        resolutionAction: action,
        resolutionReason: reason.trim(),
        resolvedByUserId: user.id,
        resolvedAt: new Date(),
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: record.organizationId,
      action: 'OFFLINE_RECONCILIATION_RESOLVED',
      entityType: 'OfflineReconciliationRecord',
      entityId: id,
      metadata: { action, outcome: record.outcome, ticketId: record.ticketId },
    });
    return updated;
  }
}
