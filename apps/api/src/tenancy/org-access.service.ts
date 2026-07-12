import { HttpStatus, Injectable } from '@nestjs/common';
import { Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/**
 * Central tenant-authorization helper. Platform admins bypass org checks;
 * everyone else must hold an active membership (optionally of a specific role).
 */
@Injectable()
export class OrgAccessService {
  constructor(private readonly prisma: PrismaService) {}

  isPlatformAdmin(user: RequestUser): boolean {
    return user.roles.includes(Role.ADMIN) || user.roles.includes(Role.SUPER_ADMIN);
  }

  /** Throws TENANT_FORBIDDEN unless the user may act within the organization. */
  async assertMember(
    user: RequestUser,
    organizationId: string,
    allowedRoles?: Role[],
  ): Promise<void> {
    if (this.isPlatformAdmin(user)) return;

    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCodes.TENANT_FORBIDDEN,
        'You are not a member of this organization.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (allowedRoles && !allowedRoles.includes(membership.role as Role)) {
      throw new AppException(
        ErrorCodes.TENANT_FORBIDDEN,
        'Your organization role does not permit this action.',
        HttpStatus.FORBIDDEN,
        { requiredRoles: allowedRoles },
      );
    }
  }

  /** Returns the organization ids the user can manage (admins get all via null). */
  async managedOrganizationIds(user: RequestUser): Promise<string[] | null> {
    if (this.isPlatformAdmin(user)) return null;
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId: user.id, status: 'ACTIVE' },
      select: { organizationId: true },
    });
    return memberships.map((m) => m.organizationId);
  }
}
