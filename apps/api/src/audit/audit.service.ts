import { Injectable, Logger } from '@nestjs/common';
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
      await this.prisma.auditLog.create({
        data: {
          actorUserId: entry.actorUserId ?? null,
          organizationId: entry.organizationId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          metadata: entry.metadata ? (entry.metadata as object) : undefined,
          correlationId: entry.correlationId ?? null,
          ip: entry.ip ?? null,
        },
      });
    } catch (err) {
      // Auditing must never break the primary operation.
      this.logger.error(`Failed to write audit log for ${entry.action}`, err as Error);
    }
  }
}
