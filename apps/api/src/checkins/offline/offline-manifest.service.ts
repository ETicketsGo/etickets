import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Role, TicketStatus } from '@eticketsgo/shared-types';
import type {
  DeltaChange,
  ManifestEntry,
  ManifestMeta,
  RevocationDelta,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';

const STAFF_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER, Role.CHECKIN_STAFF];
/** A manifest is short-lived — devices must refresh well within an event window. */
const MANIFEST_TTL_MS = 6 * 3_600_000;

export interface SignedManifest {
  meta: ManifestMeta;
  entries: ManifestEntry[];
  signature: string;
}

/**
 * Builds and signs a scoped, short-lived offline check-in manifest for a session
 * (ADR-035). Contains only the minimum validation data — no customer profiles,
 * emails, phones or payment data. The signature lets an approved device trust the
 * manifest offline without holding any QR/signing secret.
 */
@Injectable()
export class OfflineManifestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  private secret(): string {
    return (
      this.config.get<string>('MANIFEST_SIGNING_SECRET') ??
      this.config.getOrThrow<string>('QR_SIGNING_SECRET')
    );
  }

  /** Deterministic canonical serialization → HMAC-SHA256 hex. */
  sign(meta: ManifestMeta, entries: ManifestEntry[]): string {
    const canonical =
      `${meta.organizationId}|${meta.eventId}|${meta.eventSessionId}|${meta.version}|` +
      `${meta.validFrom}|${meta.expiresAt}|` +
      entries
        .map((e) => `${e.ticketId}:${e.nonce}:${e.version}:${e.status}:${e.eligible ? 1 : 0}`)
        .join(',');
    return createHmac('sha256', this.secret()).update(canonical).digest('hex');
  }

  verify(manifest: SignedManifest): boolean {
    const expected = this.sign(manifest.meta, manifest.entries);
    const a = Buffer.from(expected);
    const b = Buffer.from(manifest.signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Builds + signs the current manifest for a session and records an audit header. */
  async build(user: RequestUser, eventSessionId: string): Promise<SignedManifest> {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: eventSessionId },
      select: { id: true, event: { select: { id: true, organizationId: true } } },
    });
    if (!session)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Session not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, session.event.organizationId, STAFF_ROLES);

    const tickets = await this.prisma.ticket.findMany({
      where: {
        eventSessionId,
        status: { in: [TicketStatus.ACTIVE, TicketStatus.CHECKED_IN] },
      },
      select: { id: true, nonce: true, qrVersion: true, status: true },
    });

    const now = Date.now();
    // Monotonic per-session version (fits INT4; the unique [session, version] key
    // makes it replay-resistant). Wall-clock ms is used only for the TTL below.
    const last = await this.prisma.checkInManifest.findFirst({
      where: { eventSessionId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (last?.version ?? 0) + 1;
    const meta: ManifestMeta = {
      organizationId: session.event.organizationId,
      eventId: session.event.id,
      eventSessionId,
      version,
      validFrom: now,
      expiresAt: now + MANIFEST_TTL_MS,
    };
    const entries: ManifestEntry[] = tickets.map((t) => ({
      ticketId: t.id,
      eventSessionId,
      nonce: t.nonce,
      version: t.qrVersion,
      status: t.status,
      eligible: t.status === TicketStatus.ACTIVE,
    }));
    const signature = this.sign(meta, entries);

    await this.prisma.checkInManifest.create({
      data: {
        organizationId: meta.organizationId,
        eventId: meta.eventId,
        eventSessionId,
        version,
        validFrom: new Date(meta.validFrom),
        expiresAt: new Date(meta.expiresAt),
        ticketCount: entries.length,
        signature,
        createdByUserId: user.id,
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: meta.organizationId,
      action: 'OFFLINE_MANIFEST_ISSUED',
      entityType: 'EventSession',
      entityId: eventSessionId,
      metadata: { version, ticketCount: entries.length },
    });

    return { meta, entries, signature };
  }

  /** Signs a revocation delta (changes since a base version). */
  signDelta(delta: Omit<RevocationDelta, 'signature'>): string {
    const canonical =
      `${delta.eventSessionId}|${delta.baseVersion}|${delta.toVersion}|` +
      delta.changes
        .map((c) => `${c.ticketId}:${c.nonce}:${c.version}:${c.status}:${c.eligible ? 1 : 0}`)
        .join(',');
    return createHmac('sha256', this.secret()).update(canonical).digest('hex');
  }

  /**
   * Builds an incremental, signed revocation delta: tickets whose state changed
   * since the device's last-applied version (`sinceMs`). Compact + monotonic; the
   * device applies it atomically or, on a gap, refetches the full manifest.
   */
  async buildDelta(
    user: RequestUser,
    eventSessionId: string,
    sinceMs: number,
  ): Promise<RevocationDelta> {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: eventSessionId },
      select: { event: { select: { organizationId: true } } },
    });
    if (!session)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Session not found.', HttpStatus.NOT_FOUND);
    await this.access.assertMember(user, session.event.organizationId, STAFF_ROLES);

    const changed = await this.prisma.ticket.findMany({
      where: { eventSessionId, updatedAt: { gt: new Date(sinceMs) } },
      select: { id: true, nonce: true, qrVersion: true, status: true },
    });
    const changes: DeltaChange[] = changed.map((t) => ({
      ticketId: t.id,
      nonce: t.nonce,
      version: t.qrVersion,
      status: t.status,
      eligible: t.status === TicketStatus.ACTIVE,
    }));
    const base = { eventSessionId, baseVersion: sinceMs, toVersion: Date.now(), changes };
    return { ...base, signature: this.signDelta(base) };
  }
}
