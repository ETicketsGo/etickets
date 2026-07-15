import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import * as QRCode from 'qrcode';
import {
  NotificationType,
  ResourceType,
  SharePermission,
  TicketInviteKind,
  TicketInviteStatus,
} from '@eticketsgo/shared-types';
import type { CreateShareInput, ExtendShareInput, ShareExpiry } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { ShareableResourceRegistry } from './shareable-resource.registry';

const YEARS_100 = 100 * 365 * 86_400_000;

/**
 * Secure Experience Sharing (ADR-032). Generates signed, expiring, revocable,
 * auditable share links over a generic ShareableResource. Never mints a second
 * QR: VIEW hides the live QR, GUEST exposes the single real QR (time-limited),
 * TRANSFER hands over ownership via the attendee accept flow (which rotates the
 * nonce). Reuses the TicketInvite ledger, notifications, audit and QR signing.
 */
@Injectable()
export class SharingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly config: ConfigService,
    private readonly registry: ShareableResourceRegistry,
  ) {}

  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
  private newToken(): { raw: string; hash: string } {
    const raw = randomBytes(24).toString('base64url');
    return { raw, hash: this.hash(raw) };
  }
  private isAdmin(user: RequestUser): boolean {
    return user.roles.includes('ADMIN' as never) || user.roles.includes('SUPER_ADMIN' as never);
  }

  /** Front-end base URL for building share links (first configured CORS origin). */
  private baseUrl(): string {
    const origins = this.config.get<string>('CORS_ORIGINS') ?? 'http://localhost:3000';
    return origins.split(',')[0].trim().replace(/\/$/, '');
  }

  private expiryToDate(expiry: ShareExpiry, endsAt: Date | null): Date {
    const now = Date.now();
    switch (expiry) {
      case '1h':
        return new Date(now + 3_600_000);
      case '6h':
        return new Date(now + 6 * 3_600_000);
      case '24h':
        return new Date(now + 24 * 3_600_000);
      case 'event_end':
        return endsAt ?? new Date(now + 24 * 3_600_000);
      case 'never':
        return new Date(now + YEARS_100);
    }
  }

  // ── owner: create ─────────────────────────────────────────────────────
  async createShare(
    user: RequestUser,
    resourceType: string,
    resourceId: string,
    dto: CreateShareInput,
  ) {
    const resource = await this.registry.resolve(resourceType, resourceId);
    if (!resource)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Resource not found.', HttpStatus.NOT_FOUND);
    if (resource.ownerUserId !== user.id && !this.isAdmin(user)) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Only the owner can share this.',
        HttpStatus.FORBIDDEN,
      );
    }
    const permission = dto.permission as SharePermission;
    // Guest access + ownership transfer require a live resource; view is always ok.
    if (
      permission !== SharePermission.VIEW &&
      !resource.canShowLiveQr(SharePermission.GUEST) &&
      !resource.canTransfer(SharePermission.TRANSFER)
    ) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This item can no longer be shared for guest access or transfer.',
        HttpStatus.CONFLICT,
      );
    }

    const { raw, hash } = this.newToken();
    const expiresAt = this.expiryToDate(dto.expiry, resource.endsAt);
    const invite = await this.prisma.ticketInvite.create({
      data: {
        ticketId: resourceId,
        organizationId: resource.organizationId,
        kind:
          permission === SharePermission.TRANSFER
            ? TicketInviteKind.TRANSFER
            : TicketInviteKind.INVITE,
        permission,
        resourceType: resourceType as ResourceType,
        status: TicketInviteStatus.PENDING,
        email: dto.email ?? null,
        label: dto.label ?? null,
        maxOpens: dto.maxOpens ?? null,
        tokenHash: hash,
        expiresAt,
        createdByUserId: user.id,
      },
    });

    const shareUrl = `${this.baseUrl()}/share/${raw}`;
    const qrDataUrl = await QRCode.toDataURL(shareUrl, { margin: 1, width: 320 });

    if (dto.email) {
      await this.notifications.send({
        type: NotificationType.SHARE_CREATED,
        toEmail: dto.email,
        payload: { permission, url: shareUrl },
      });
    }
    await this.audit.record({
      actorUserId: user.id,
      organizationId: resource.organizationId,
      action: 'SHARE_CREATED',
      entityType: 'Ticket',
      entityId: resourceId,
      metadata: { shareId: invite.id, permission, expiresAt },
    });

    return {
      id: invite.id,
      token: raw,
      shareUrl,
      qrDataUrl,
      permission,
      expiresAt: expiresAt.toISOString(),
      maxOpens: invite.maxOpens,
    };
  }

  // ── recipient: resolve (public) ───────────────────────────────────────
  async resolveShare(rawToken: string, ctx: { userId?: string }) {
    const invite = await this.prisma.ticketInvite.findUnique({
      where: { tokenHash: this.hash(rawToken) },
    });
    if (!invite || invite.status === TicketInviteStatus.DECLINED)
      throw new AppException(ErrorCodes.NOT_FOUND, 'This link is not valid.', HttpStatus.NOT_FOUND);
    if (invite.status === TicketInviteStatus.REVOKED)
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This share has been revoked.',
        HttpStatus.CONFLICT,
      );
    if (
      invite.status === TicketInviteStatus.ACCEPTED &&
      invite.permission === SharePermission.TRANSFER
    )
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This ticket has already been claimed.',
        HttpStatus.CONFLICT,
      );
    if (invite.expiresAt.getTime() <= Date.now()) {
      await this.markExpired(invite.id);
      throw new AppException(ErrorCodes.CONFLICT, 'This share has expired.', HttpStatus.CONFLICT);
    }
    if (invite.maxOpens != null && invite.openCount >= invite.maxOpens) {
      await this.markExpired(invite.id);
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This share has reached its open limit.',
        HttpStatus.CONFLICT,
      );
    }

    const resource = await this.registry.resolve(invite.resourceType, invite.ticketId);
    if (!resource)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Resource not found.', HttpStatus.NOT_FOUND);

    const firstOpen = invite.openCount === 0;
    await this.prisma.ticketInvite.update({
      where: { id: invite.id },
      data: {
        openCount: { increment: 1 },
        lastOpenedAt: new Date(),
        lastOpenedByUserId: ctx.userId ?? null,
      },
    });
    await this.audit.record({
      organizationId: invite.organizationId,
      actorUserId: ctx.userId,
      action: 'SHARE_OPENED',
      entityType: 'Ticket',
      entityId: invite.ticketId,
      metadata: { shareId: invite.id, permission: invite.permission },
    });
    // Notify the owner on the first open only (avoid notification spam).
    if (firstOpen && invite.createdByUserId) {
      await this.notifications.send({
        type: NotificationType.SHARE_VIEWED,
        userId: invite.createdByUserId,
        payload: { ticketId: invite.ticketId, permission: invite.permission },
      });
    }

    const permission = invite.permission as SharePermission;
    let qrDataUrl: string | null = null;
    if (resource.canShowLiveQr(permission)) {
      const token = resource.liveQrToken();
      if (token) qrDataUrl = await QRCode.toDataURL(token, { margin: 1, width: 320 });
    }

    return {
      permission,
      resource: resource.toShareView(),
      qrDataUrl,
      canCheckIn: resource.canCheckIn(permission),
      canTransfer: resource.canTransfer(permission),
      canDownload: resource.canDownload(permission),
      expiresAt: invite.expiresAt.toISOString(),
      remainingOpens:
        invite.maxOpens != null ? Math.max(0, invite.maxOpens - (invite.openCount + 1)) : null,
    };
  }

  private markExpired(id: string) {
    return this.prisma.ticketInvite.update({
      where: { id },
      data: { status: TicketInviteStatus.EXPIRED, resolvedAt: new Date() },
    });
  }

  // ── owner: manage ─────────────────────────────────────────────────────
  private async loadOwnedShare(user: RequestUser, shareId: string) {
    const invite = await this.prisma.ticketInvite.findUnique({
      where: { id: shareId },
      include: { ticket: { select: { booking: { select: { userId: true } } } } },
    });
    if (!invite)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Share not found.', HttpStatus.NOT_FOUND);
    if (invite.ticket.booking.userId !== user.id && !this.isAdmin(user)) {
      throw new AppException(ErrorCodes.FORBIDDEN, 'Not your share.', HttpStatus.FORBIDDEN);
    }
    return invite;
  }

  async revoke(user: RequestUser, shareId: string) {
    const invite = await this.loadOwnedShare(user, shareId);
    await this.prisma.ticketInvite.update({
      where: { id: shareId },
      data: { status: TicketInviteStatus.REVOKED, resolvedAt: new Date() },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: invite.organizationId,
      action: 'SHARE_REVOKED',
      entityType: 'Ticket',
      entityId: invite.ticketId,
      metadata: { shareId },
    });
    return { id: shareId, status: TicketInviteStatus.REVOKED };
  }

  async extend(user: RequestUser, shareId: string, dto: ExtendShareInput) {
    const invite = await this.loadOwnedShare(user, shareId);
    if (
      invite.status !== TicketInviteStatus.PENDING &&
      invite.status !== TicketInviteStatus.EXPIRED
    ) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Only an active or expired share can be extended.',
        HttpStatus.CONFLICT,
      );
    }
    const resource = await this.registry.resolve(invite.resourceType, invite.ticketId);
    const expiresAt = this.expiryToDate(dto.expiry, resource?.endsAt ?? null);
    await this.prisma.ticketInvite.update({
      where: { id: shareId },
      data: { expiresAt, status: TicketInviteStatus.PENDING },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: invite.organizationId,
      action: 'SHARE_EXTENDED',
      entityType: 'Ticket',
      entityId: invite.ticketId,
      metadata: { shareId, expiresAt },
    });
    return { id: shareId, expiresAt: expiresAt.toISOString() };
  }

  async changePermission(user: RequestUser, shareId: string, permission: SharePermission) {
    const invite = await this.loadOwnedShare(user, shareId);
    if (invite.status !== TicketInviteStatus.PENDING) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Only an active share can change permission.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.ticketInvite.update({
      where: { id: shareId },
      data: {
        permission,
        kind:
          permission === SharePermission.TRANSFER
            ? TicketInviteKind.TRANSFER
            : TicketInviteKind.INVITE,
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: invite.organizationId,
      action: 'SHARE_PERMISSION_CHANGED',
      entityType: 'Ticket',
      entityId: invite.ticketId,
      metadata: { shareId, permission },
    });
    return { id: shareId, permission };
  }

  /** Owner activity: all shares for a ticket + a status/opens summary. */
  async activityForTicket(user: RequestUser, ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { booking: { select: { userId: true } } },
    });
    if (!ticket)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Ticket not found.', HttpStatus.NOT_FOUND);
    if (ticket.booking.userId !== user.id && !this.isAdmin(user)) {
      throw new AppException(ErrorCodes.FORBIDDEN, 'Not your ticket.', HttpStatus.FORBIDDEN);
    }
    const shares = await this.prisma.ticketInvite.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        permission: true,
        status: true,
        email: true,
        label: true,
        openCount: true,
        maxOpens: true,
        expiresAt: true,
        lastOpenedAt: true,
        createdAt: true,
      },
    });
    return {
      ticketId,
      shares: shares.map((s) => ({ ...s, expiresAt: s.expiresAt.toISOString() })),
    };
  }
}
