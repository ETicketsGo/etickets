import { HttpStatus, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { CheckInResult, CheckInDeviceStatus, Role, TicketStatus } from '@eticketsgo/shared-types';
import {
  classifyReconciliation,
  initialReviewState,
  PREFLIGHT_CLOCK_TOLERANCE_MS,
  type QueuedCheckIn,
  type ReconcileOutcome,
  type ServerTicketState,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';
import { deviceIsOperational, deviceNotActiveError, effectiveDeviceStatus } from './device-gate';

const STAFF_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];
/**
 * The most scans one refused upload may leave as evidence. A door phone's queue is a few
 * hundred scans at most; the cap only stops a refused device from writing without limit.
 */
export const QUARANTINE_MAX_PER_UPLOAD = 1000;

/** Why a scan's cited ticket list does not cover it (H5); null when it does. */
export type ManifestProblem =
  'NO_MANIFEST' | 'OTHER_DEVICE' | 'SIGNATURE_MISMATCH' | 'OUTSIDE_VALIDITY';

/** The stored header of a list the server issued (CheckInManifest). */
export interface IssuedManifest {
  deviceId: string | null;
  validFrom: Date;
  expiresAt: Date;
  signature: string;
}

/**
 * Whether a queued scan was validated against a list issued to THIS device, and made inside
 * that list's validity (H5). Pure, so the rule is unit-tested on its own.
 *
 * The scan cites the list by version and signature. The server compares them with what it
 * stored when it issued the list, so the device needs no secret and the server needs no copy
 * of the entries. `checkedInAt` is the device's clock: a small tolerance absorbs drift, and a
 * device that lies about the time only moves its scan into review, never into admission.
 */
export function manifestProblem(
  q: Pick<QueuedCheckIn, 'checkedInAt' | 'manifestSignature'>,
  deviceId: string,
  issued: IssuedManifest | null,
): ManifestProblem | null {
  if (!issued || !q.manifestSignature) return 'NO_MANIFEST';
  if (!issued.deviceId || issued.deviceId !== deviceId) return 'OTHER_DEVICE';
  const a = Buffer.from(issued.signature);
  const b = Buffer.from(q.manifestSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'SIGNATURE_MISMATCH';
  if (
    q.checkedInAt < issued.validFrom.getTime() - PREFLIGHT_CLOCK_TOLERANCE_MS ||
    q.checkedInAt > issued.expiresAt.getTime() + PREFLIGHT_CLOCK_TOLERANCE_MS
  ) {
    return 'OUTSIDE_VALIDITY';
  }
  return null;
}

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
    /*
      Only an ACTIVE, unexpired device's queue is applied (H5). This refused REVOKED only, so a
      SUSPENDED device - suspended because it was misbehaving, or while a manager looked into
      it - kept uploading scans and spending tickets, and so did a PENDING one nobody approved.
    */
    if (!deviceIsOperational(device)) {
      const held = await this.quarantine(user, device, queued);
      throw deviceNotActiveError(device, { heldForReview: held });
    }

    const manifests = await this.issuedManifests(queued);
    const results: ReconcileResultItem[] = [];
    for (const q of queued) {
      const found = await this.prisma.ticket.findUnique({
        where: { id: q.ticketId },
        include: {
          checkIns: {
            where: { result: CheckInResult.SUCCESS, reversed: false },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
          eventSession: { select: { event: { select: { organizationId: true } } } },
        },
      });
      /*
        Only this device's organization's tickets.

        The caller is authorized for the DEVICE's organization, and the queued ticket id was
        trusted as-is — so staff of one organization could upload another's ticket id and mark
        it CHECKED_IN, spending somebody else's admission. A foreign ticket is treated exactly
        like one that does not exist: nothing is claimed, it goes to supervisor review, and
        the answer does not reveal that the id belongs to someone.
      */
      const ticket =
        found && found.eventSession.event.organizationId === device.organizationId ? found : null;
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

      /*
        The scan must cite a list issued to this device and claim a time inside it (H5). That is
        what makes the revocation window hold on the server too: a scan made on an expired list,
        or on a list copied from another phone, is held for a manager instead of spending the
        ticket. It is checked before the ticket state because it decides whether the scan is
        evidence of anything at all.
      */
      const problem = manifestProblem(
        q,
        deviceId,
        manifests.get(`${q.eventSessionId}|${q.manifestVersion}`) ?? null,
      );
      const outcome: ReconcileOutcome = problem
        ? 'MANIFEST_NOT_VALID'
        : classifyReconciliation(q, server);

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

      // Durable ledger entry for the Reconciliation Console. The outcome is
      // immutable; only supervisor resolution (audit-only) may annotate it later.
      const record = await this.prisma.offlineReconciliationRecord.create({
        data: {
          organizationId: device.organizationId,
          eventId: device.eventId,
          eventSessionId: q.eventSessionId,
          deviceId,
          ticketId: q.ticketId,
          operatorUserId: user.id,
          localScannedAt: new Date(q.checkedInAt),
          outcome,
          wasOverride: q.wasOverride,
          reviewState: initialReviewState(outcome),
        },
      });

      await this.audit.record({
        actorUserId: user.id,
        organizationId: device.organizationId,
        action: 'OFFLINE_CHECKIN_RECONCILED',
        entityType: 'OfflineReconciliationRecord',
        entityId: record.id,
        metadata: {
          deviceId,
          ticketId: q.ticketId,
          outcome,
          wasOverride: q.wasOverride,
          ...(problem
            ? { manifestProblem: problem, manifestVersion: q.manifestVersion ?? null }
            : {}),
        },
      });
      results.push({ ticketId: q.ticketId, outcome });
    }

    await this.prisma.checkInDevice.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date() },
    });
    return results;
  }

  /** The issued lists the queue cites, keyed `${eventSessionId}|${version}`. */
  private async issuedManifests(queued: QueuedCheckIn[]): Promise<Map<string, IssuedManifest>> {
    const keys = new Map<string, { eventSessionId: string; version: number }>();
    for (const q of queued) {
      if (typeof q.manifestVersion !== 'number' || !Number.isInteger(q.manifestVersion)) continue;
      keys.set(`${q.eventSessionId}|${q.manifestVersion}`, {
        eventSessionId: q.eventSessionId,
        version: q.manifestVersion,
      });
    }
    if (keys.size === 0) return new Map();
    const rows = await this.prisma.checkInManifest.findMany({
      where: { OR: [...keys.values()] },
      select: {
        eventSessionId: true,
        version: true,
        deviceId: true,
        validFrom: true,
        expiresAt: true,
        signature: true,
      },
    });
    return new Map(
      rows.map((r: IssuedManifest & { eventSessionId: string; version: number }) => [
        `${r.eventSessionId}|${r.version}`,
        r,
      ]),
    );
  }

  /**
   * Keeps a refused device's queue as evidence and applies none of it (H5).
   *
   * THE SAFETY CALL. A device suspended or revoked while it was offline may hold genuine scans
   * - people really were let in while it was still trusted - or scans made after it was cut
   * off, by somebody who should not be holding it. The server cannot tell which: the scan
   * times come from the device's own clock. So nothing is applied automatically, in either
   * direction. Each scan becomes a DEVICE_NOT_ACTIVE row in the reconciliation ledger, PENDING
   * a manager's review, and the ticket is left exactly as it was. Dropping the scans would lose
   * the record of who came in; applying them would let a cut-off phone spend tickets.
   *
   * A PENDING device keeps nothing: it was never approved, so it never held a list and none of
   * its scans can be an admission. Re-uploads are not stored twice, and one upload stores at
   * most QUARANTINE_MAX_PER_UPLOAD rows.
   */
  private async quarantine(
    user: RequestUser,
    device: {
      id: string;
      organizationId: string;
      eventId: string | null;
      status: string;
      expiresAt: Date | null;
    },
    queued: QueuedCheckIn[],
  ): Promise<number> {
    const status = effectiveDeviceStatus(device);
    if (device.status === CheckInDeviceStatus.PENDING) {
      await this.audit.record({
        actorUserId: user.id,
        organizationId: device.organizationId,
        action: 'OFFLINE_UPLOAD_REFUSED',
        entityType: 'CheckInDevice',
        entityId: device.id,
        metadata: { deviceStatus: status, scans: queued.length, heldForReview: 0 },
      });
      return 0;
    }
    const manifests = await this.issuedManifests(queued);
    let held = 0;
    for (const q of queued.slice(0, QUARANTINE_MAX_PER_UPLOAD)) {
      if (!q?.ticketId || !q.eventSessionId || !Number.isFinite(q.checkedInAt)) continue;
      const localScannedAt = new Date(q.checkedInAt);
      const already = await this.prisma.offlineReconciliationRecord.findFirst({
        where: {
          deviceId: device.id,
          ticketId: q.ticketId,
          localScannedAt,
          outcome: 'DEVICE_NOT_ACTIVE',
        },
        select: { id: true },
      });
      if (already) continue;
      const outcome: ReconcileOutcome = 'DEVICE_NOT_ACTIVE';
      const record = await this.prisma.offlineReconciliationRecord.create({
        data: {
          organizationId: device.organizationId,
          eventId: device.eventId,
          eventSessionId: q.eventSessionId,
          deviceId: device.id,
          ticketId: q.ticketId,
          operatorUserId: user.id,
          localScannedAt,
          outcome,
          wasOverride: q.wasOverride === true,
          reviewState: initialReviewState(outcome),
        },
      });
      // What the manager reviewing it needs: was the device trusted with a list covering the
      // time it claims? That is evidence, not a decision; the ticket is untouched either way.
      const problem = manifestProblem(
        q,
        device.id,
        manifests.get(`${q.eventSessionId}|${q.manifestVersion}`) ?? null,
      );
      await this.audit.record({
        actorUserId: user.id,
        organizationId: device.organizationId,
        action: 'OFFLINE_CHECKIN_RECONCILED',
        entityType: 'OfflineReconciliationRecord',
        entityId: record.id,
        metadata: {
          deviceId: device.id,
          ticketId: q.ticketId,
          outcome,
          deviceStatus: status,
          manifestCheck: problem ?? 'COVERED',
          manifestVersion: q.manifestVersion ?? null,
          wasOverride: q.wasOverride === true,
        },
      });
      held += 1;
    }
    await this.audit.record({
      actorUserId: user.id,
      organizationId: device.organizationId,
      action: 'OFFLINE_UPLOAD_REFUSED',
      entityType: 'CheckInDevice',
      entityId: device.id,
      metadata: { deviceStatus: status, scans: queued.length, heldForReview: held },
    });
    return held;
  }
}
