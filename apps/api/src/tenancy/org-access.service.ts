import { HttpStatus, Injectable } from '@nestjs/common';
import { AdminPermission, Role, permissionsFor } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { currentRequest } from '../common/request-context';
import type { RequestUser } from '../common/decorators';

/**
 * What a member of platform staff needs to perform ONE organizer-side operation for an
 * organization they do not belong to.
 *
 * Named at the call site, per operation, so the list of things staff may do inside an
 * organization is a list somebody can read (docs/security/ADMIN-PERMISSION-MATRIX.md, section
 * "Organizer API") rather than "anything".
 */
export interface PlatformPolicy {
  /** The back-office capability required. A super admin holds every one by role. */
  permission: AdminPermission;
  /** Stable name written to the audit row, e.g. `organization.read`. */
  operation: string;
}

/** Audit actions for platform staff reaching into an organization. */
export const PLATFORM_ORGANIZER_ACCESS_ALLOWED = 'PLATFORM_ORGANIZER_ACCESS_ALLOWED';
export const PLATFORM_ORGANIZER_ACCESS_DENIED = 'PLATFORM_ORGANIZER_ACCESS_DENIED';

/**
 * Central tenant-authorization helper.
 *
 * ── MEMBERSHIP DECIDES, AND PLATFORM ROLE ALONE DECIDES NOTHING ───────────────────────
 * This used to return early for ANY platform `ADMIN`: no membership lookup and no capability
 * check. Every organizer route asserts membership through here, so a back-office account
 * holding no capability at all could save an organization's payout bank account, raise a
 * payout, record cash, rewrite legal identity, edit and delete events, reverse check-ins -
 * for every organization on the platform. The capability model on `/admin` was complete and
 * this door sat beside it.
 *
 * Now:
 *   - Anybody, staff included, who holds an ACTIVE membership with an allowed role passes, as
 *     a member. Organizer behaviour is unchanged.
 *   - Platform staff who are not such a member pass only where the call site names a
 *     {@link PlatformPolicy} AND they hold its capability. Most call sites name none, so most
 *     organizer operations are closed to staff entirely - by default, which is what makes a
 *     new organizer route safe without anybody remembering this file.
 *   - Every such attempt by staff, allowed or refused, is written to the audit log with the
 *     target organization, the operation and the result.
 *
 * A super admin is no exception to the default: it holds every capability, so it passes every
 * NAMED policy, but where no policy is named it is refused like anybody else. "Super admin can
 * do anything on the organizer API" would be a second, unlisted bypass.
 */
@Injectable()
export class OrgAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * True for a back-office account. Identifies; never authorizes. Whether such an account may
   * do something is {@link platformHolds} or a {@link PlatformPolicy}.
   */
  isPlatformAdmin(user: RequestUser): boolean {
    return user.roles.includes(Role.ADMIN) || user.roles.includes(Role.SUPER_ADMIN);
  }

  /** Whether a platform account holds this capability, read from the database now. */
  async platformHolds(user: RequestUser, permission: AdminPermission): Promise<boolean> {
    if (!this.isPlatformAdmin(user)) return false;
    // Grants are read per call rather than trusted from the token, as AdminPermissionGuard
    // does, so a revoked capability stops working on the next request.
    const rows = await this.prisma.adminGrant.findMany({
      where: { userId: user.id },
      select: { permission: true },
    });
    return permissionsFor(
      user.roles,
      rows.map((r) => r.permission as AdminPermission),
    ).has(permission);
  }

  /** Throws TENANT_FORBIDDEN unless the user may act within the organization. */
  async assertMember(
    user: RequestUser,
    organizationId: string,
    allowedRoles?: Role[],
    platform?: PlatformPolicy,
  ): Promise<void> {
    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } },
    });
    const active = !!membership && membership.status === 'ACTIVE';
    const roleAllowed = active && (!allowedRoles || allowedRoles.includes(membership.role as Role));
    if (roleAllowed) return;

    if (this.isPlatformAdmin(user)) {
      await this.assertPlatformAccess(user, organizationId, allowedRoles, platform);
      return;
    }

    if (!active) {
      throw new AppException(
        ErrorCodes.TENANT_FORBIDDEN,
        'You are not a member of this organization.',
        HttpStatus.FORBIDDEN,
      );
    }
    throw new AppException(
      ErrorCodes.TENANT_FORBIDDEN,
      'Your organization role does not permit this action.',
      HttpStatus.FORBIDDEN,
      { requiredRoles: allowedRoles },
    );
  }

  /**
   * Platform staff acting on something that belongs to an organization or a customer, where
   * no membership could apply: deciding a refund, reading a buyer's refunds. Same rule as the
   * staff half of {@link assertMember}: the named capability, audited either way.
   */
  async assertPlatformCapability(
    user: RequestUser,
    policy: PlatformPolicy & {
      organizationId?: string | null;
      entityType: string;
      entityId: string;
      /** The refusal's wording, where the caller already had one people rely on. */
      message?: string;
    },
  ): Promise<void> {
    const allowed = await this.platformHolds(user, policy.permission);
    await this.record(user, {
      allowed,
      organizationId: policy.organizationId ?? null,
      entityType: policy.entityType,
      entityId: policy.entityId,
      operation: policy.operation,
      permission: policy.permission,
      reason: allowed ? 'CAPABILITY_HELD' : 'CAPABILITY_MISSING',
    });
    if (!allowed) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        policy.message ?? 'Your account does not have permission to do that.',
        HttpStatus.FORBIDDEN,
        { required: [policy.permission] },
      );
    }
  }

  /**
   * Records that platform staff were refused an operation no capability opens - asking for a
   * refund on a customer's booking, say - so the attempt is on the record like every other
   * staff reach into an organization. Throws nothing: the caller refuses in its own words.
   */
  async recordPlatformRefusal(
    user: RequestUser,
    target: {
      organizationId?: string | null;
      entityType: string;
      entityId: string;
      operation: string;
    },
  ): Promise<void> {
    await this.record(user, {
      allowed: false,
      organizationId: target.organizationId ?? null,
      entityType: target.entityType,
      entityId: target.entityId,
      operation: target.operation,
      permission: null,
      reason: 'NO_PLATFORM_POLICY',
    });
  }

  /**
   * The organizations the user works in: their ACTIVE memberships, for everybody.
   *
   * Platform staff used to get every organization on the platform here, which is how the
   * organizer console listed - and let them operate - all of them. Staff look at
   * organizations through the admin console, which has its own capability-checked routes.
   */
  async managedOrganizationIds(user: RequestUser): Promise<string[]> {
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId: user.id, status: 'ACTIVE' },
      select: { organizationId: true },
    });
    return memberships.map((m) => m.organizationId);
  }

  private async assertPlatformAccess(
    user: RequestUser,
    organizationId: string,
    allowedRoles: Role[] | undefined,
    platform: PlatformPolicy | undefined,
  ): Promise<void> {
    if (!platform) {
      await this.record(user, {
        allowed: false,
        organizationId,
        entityType: 'Organization',
        entityId: organizationId,
        operation: null,
        permission: null,
        reason: 'NO_PLATFORM_POLICY',
        allowedRoles,
      });
      // The answer a non-member gets: there is no staff route into this operation.
      throw new AppException(
        ErrorCodes.TENANT_FORBIDDEN,
        'You are not a member of this organization.',
        HttpStatus.FORBIDDEN,
      );
    }
    const allowed = await this.platformHolds(user, platform.permission);
    await this.record(user, {
      allowed,
      organizationId,
      entityType: 'Organization',
      entityId: organizationId,
      operation: platform.operation,
      permission: platform.permission,
      reason: allowed ? 'CAPABILITY_HELD' : 'CAPABILITY_MISSING',
      allowedRoles,
    });
    if (!allowed) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Your account does not have permission to do that.',
        HttpStatus.FORBIDDEN,
        { required: [platform.permission] },
      );
    }
  }

  private async record(
    user: RequestUser,
    entry: {
      allowed: boolean;
      organizationId: string | null;
      entityType: string;
      entityId: string;
      operation: string | null;
      permission: AdminPermission | null;
      reason: 'CAPABILITY_HELD' | 'CAPABILITY_MISSING' | 'NO_PLATFORM_POLICY';
      allowedRoles?: Role[];
    },
  ): Promise<void> {
    const request = currentRequest();
    const requestLine = request ? `${request.method} ${request.path}` : null;
    await this.audit.record({
      actorUserId: user.id,
      organizationId: entry.organizationId,
      action: entry.allowed ? PLATFORM_ORGANIZER_ACCESS_ALLOWED : PLATFORM_ORGANIZER_ACCESS_DENIED,
      entityType: entry.entityType,
      entityId: entry.entityId,
      correlationId: request?.correlationId ?? null,
      metadata: {
        result: entry.allowed ? 'ALLOWED' : 'DENIED',
        // Where no policy was named, the request line is the best name the operation has.
        operation: entry.operation ?? requestLine ?? 'unnamed organizer operation',
        permission: entry.permission,
        reason: entry.reason,
        organizerRoles: entry.allowedRoles ?? null,
        request: requestLine,
      },
    });
  }
}
