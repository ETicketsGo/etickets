import { HttpStatus, Injectable } from '@nestjs/common';
import { CheckInResult, CheckInDeviceStatus, Role, TicketStatus } from '@eticketsgo/shared-types';
import {
  classifyReconciliation,
  type QueuedCheckIn,
  type ReconcileOutcome,
  type ServerTicketState,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';

const STAFF_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];

export interface ReconcileResultItem {
  ticketId: string;
  outcome: ReconcileOutcome;
}

/**
 * Reconciles queued offline check-ins against current server state (ADR-035). The
 * server always wins: refunded/transferred/revoked-after-download and cross-device
 * duplicates are surfaced, never silently accepted. Accepting is idempotent — the
 * same atomic ACTIVE→CHECKED_IN guard as online check-in prevents double issue.
 */
@Injectable()
export class OfflineReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  async reconcile(
    user: RequestUser,
    deviceId: string,
    queued: QueuedCheckIn[],
  ): Promise<ReconcileResultItem[]> {
    const device = await this.prisma.checkInDevice.findUnique({ where: { id: deviceId } });
    if (!device)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Device not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, device.organizationId, STAFF_ROLES);
    // A revoked/expired device's offline queue is not silently accepted.
    if (device.status === CheckInDeviceStatus.REVOKED) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'This device has been revoked.',
        HttpStatus.FORBIDDEN,
      );
    }

    const results: ReconcileResultItem[] = [];
    for (const q of queued) {
      const ticket = await this.prisma.ticket.findUnique({
        where: { id: q.ticketId },
        include: {
          checkIns: {
            where: { result: CheckInResult.SUCCESS, reversed: false },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      });
      const server: ServerTicketState | null = ticket
        ? {
            status: ticket.status,
            nonce: ticket.nonce,
            version: ticket.qrVersion,
            eventSessionId: ticket.eventSessionId,
            checkedIn:
              ticket.status === TicketStatus.CHECKED_IN || ticket.checkIns.length > 0
                ? {
                    deviceId: (ticket.checkIns[0]?.deviceInfo as string | null) ?? null,
                    online: !ticket.checkIns[0]?.deviceInfo,
                  }
                : null,
          }
        : null;

      const outcome = classifyReconciliation(q, server);

      if (outcome === 'ACCEPTED' && ticket) {
        // Idempotent atomic claim — identical to online check-in.
        const claim = await this.prisma.ticket.updateMany({
          where: { id: ticket.id, status: TicketStatus.ACTIVE },
          data: { status: TicketStatus.CHECKED_IN },
        });
        if (claim.count === 1) {
          await this.prisma.checkIn.create({
            data: {
              ticketId: ticket.id,
              eventSessionId: ticket.eventSessionId,
              result: CheckInResult.SUCCESS,
              byUserId: user.id,
              deviceInfo: deviceId,
            },
          });
        } else {
          results.push({ ticketId: q.ticketId, outcome: 'DUPLICATE_OTHER_DEVICE' });
          continue;
        }
      }

      await this.audit.record({
        actorUserId: user.id,
        organizationId: device.organizationId,
        action: 'OFFLINE_CHECKIN_RECONCILED',
        entityType: 'Ticket',
        entityId: q.ticketId,
        metadata: { deviceId, outcome, wasOverride: q.wasOverride },
      });
      results.push({ ticketId: q.ticketId, outcome });
    }

    await this.prisma.checkInDevice.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date() },
    });
    return results;
  }
}
