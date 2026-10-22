import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actorUserId?: string | null;
  organizationId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  ip?: string | null;
}

/** Writes immutable audit records for admin, payment, refund, payout, check-in, etc. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: rowFor(entry) });
    } catch (err) {
      // Auditing must never break the primary operation.
      this.logger.error(`Failed to write audit log for ${entry.action}`, err as Error);
    }
  }

  /**
   * Write the audit row inside the caller's transaction, and let a failure fail the action.
   *
   * `record` swallows its errors on purpose: a checkout must not fail because the log is slow.
   * That trade is wrong for the few actions whose whole point is accountability - changing what
   * a member of staff may do, suspending an account, signing somebody out everywhere. An
   * unaudited change of who holds power is worse than no change, so for those the row and the
   * change commit together or not at all. Opt-in per call site; `record` is unchanged.
   */
  async recordInTransaction(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({ data: rowFor(entry) });
  }
}

function rowFor(entry: AuditEntry) {
  return {
    actorUserId: entry.actorUserId ?? null,
    organizationId: entry.organizationId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ? (entry.metadata as object) : undefined,
    correlationId: entry.correlationId ?? null,
    ip: entry.ip ?? null,
  };
}
