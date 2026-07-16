import { HttpStatus, Injectable } from '@nestjs/common';
import { CheckInDeviceStatus, Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';

const MANAGER_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];
const STAFF_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];
const DEVICE_TTL_MS = 30 * 86_400_000;

export interface RegisterDeviceInput {
  organizationId: string;
  eventId?: string;
  eventSessionId?: string;
  name: string;
  platform?: string;
  /** Public key reference only — the private key never leaves the device. */
  publicKeyRef?: string;
}

/**
 * Registered check-in devices (ADR-035). Devices are event/session-scoped, must be
 * approved by a manager, expire, and can be revoked remotely (lost device). There
 * is never a generic org-wide offline credential.
 */
@Injectable()
export class CheckInDeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  async register(user: RequestUser, input: RegisterDeviceInput) {
    await this.access.assertMember(user, input.organizationId, STAFF_ROLES);
    const device = await this.prisma.checkInDevice.create({
      data: {
        organizationId: input.organizationId,
        eventId: input.eventId ?? null,
        eventSessionId: input.eventSessionId ?? null,
        assignedStaffUserId: user.id,
        name: input.name,
        platform: input.platform ?? null,
        publicKeyRef: input.publicKeyRef ?? null,
        status: CheckInDeviceStatus.PENDING,
        createdByUserId: user.id,
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: input.organizationId,
      action: 'CHECKIN_DEVICE_REGISTERED',
      entityType: 'CheckInDevice',
      entityId: device.id,
    });
    return device;
  }

  private async load(user: RequestUser, id: string, roles: Role[]) {
    const device = await this.prisma.checkInDevice.findUnique({ where: { id } });
    if (!device)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Device not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, device.organizationId, roles);
    return device;
  }

  async approve(user: RequestUser, id: string) {
    const device = await this.load(user, id, MANAGER_ROLES);
    const updated = await this.prisma.checkInDevice.update({
      where: { id },
      data: {
        status: CheckInDeviceStatus.ACTIVE,
        approvedByUserId: user.id,
        expiresAt: new Date(Date.now() + DEVICE_TTL_MS),
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: device.organizationId,
      action: 'CHECKIN_DEVICE_APPROVED',
      entityType: 'CheckInDevice',
      entityId: id,
    });
    return updated;
  }

  /** Temporarily suspends an ACTIVE/PENDING device (reversible via approve). */
  async suspend(user: RequestUser, id: string, reason?: string) {
    const device = await this.load(user, id, MANAGER_ROLES);
    if (device.status === CheckInDeviceStatus.REVOKED) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'A revoked device cannot be suspended.',
        HttpStatus.CONFLICT,
      );
    }
    const updated = await this.prisma.checkInDevice.update({
      where: { id },
      data: { status: CheckInDeviceStatus.SUSPENDED },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: device.organizationId,
      action: 'CHECKIN_DEVICE_SUSPENDED',
      entityType: 'CheckInDevice',
      entityId: id,
      metadata: reason ? { reason } : undefined,
    });
    return updated;
  }

  async revoke(user: RequestUser, id: string, reason?: string) {
    const device = await this.load(user, id, MANAGER_ROLES);
    const updated = await this.prisma.checkInDevice.update({
      where: { id },
      data: { status: CheckInDeviceStatus.REVOKED },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: device.organizationId,
      action: 'CHECKIN_DEVICE_REVOKED',
      entityType: 'CheckInDevice',
      entityId: id,
      metadata: reason ? { reason } : undefined,
    });
    return updated;
  }

  /** Reports a device lost/stolen — revokes it and records a distinct audit action. */
  async reportLost(user: RequestUser, id: string, reason: string) {
    const device = await this.load(user, id, MANAGER_ROLES);
    const updated = await this.prisma.checkInDevice.update({
      where: { id },
      data: { status: CheckInDeviceStatus.REVOKED },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: device.organizationId,
      action: 'CHECKIN_DEVICE_REPORTED_LOST',
      entityType: 'CheckInDevice',
      entityId: id,
      metadata: { reason, lost: true },
    });
    return updated;
  }

  async list(user: RequestUser, organizationId: string, eventId?: string) {
    await this.access.assertMember(user, organizationId, STAFF_ROLES);
    return this.prisma.checkInDevice.findMany({
      where: { organizationId, ...(eventId ? { eventId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200, // bounded — a device fleet per org is small; avoids unbounded scans
    });
  }

  /** True when a device is ACTIVE and not expired — required to validate offline. */
  isOperational(device: { status: string; expiresAt: Date | null }): boolean {
    if (device.status !== CheckInDeviceStatus.ACTIVE) return false;
    return !device.expiresAt || device.expiresAt.getTime() > Date.now();
  }
}
