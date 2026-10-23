import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OpsAlertService } from '../ops/alerts/ops-alert.service';
import { securityAlertForAudit } from '../ops/alerts/security-audit-alerts';

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

  constructor(
    private readonly prisma: PrismaService,
    /*
      Optional and last: absent (a hand-built harness, or a process without the ops alerts
      module) nothing is mailed and every audit write is exactly what it was.
    */
    @Optional() private readonly alerts?: OpsAlertService,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: rowFor(entry) });
    } catch (err) {
      // Auditing must never break the primary operation.
      this.logger.error(`Failed to write audit log for ${entry.action}`, err as Error);
    }
    // Raised even if the row failed: the event happened, and then the email is all there is.
    this.afterCommit(entry);
  }

  /**
   * Raise the security alert for an entry, if its action has one (see
   * ops/alerts/security-audit-alerts.ts). `record` calls it itself. A caller of
   * `recordInTransaction` calls it once its transaction has committed, so a change that rolled
   * back is never mailed.
   *
   * Never throws and never waits: the alert is fire-and-forget, like every ops alert.
   */
  afterCommit(entry: AuditEntry): void {
    if (!this.alerts) return;
    try {
      const alert = securityAlertForAudit(entry);
      if (alert) void this.alerts.notify(alert);
    } catch (err) {
      this.logger.error(
        `Security alert for ${entry.action} could not be raised: ${(err as Error)?.message}`,
      );
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
   *
   * Raises no alert, because the transaction may still roll back. Call `afterCommit` with the
   * same entry once it has committed.
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
