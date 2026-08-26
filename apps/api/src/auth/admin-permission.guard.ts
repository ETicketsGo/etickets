import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminPermission, permissionsFor } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AppException, ErrorCodes } from '../common/errors';
import { ADMIN_PERMISSION_KEY, type RequestUser } from '../common/decorators';

/**
 * Enforces `@RequiresAdmin(...)`.
 *
 * ── WHAT MAKES THIS SAFE ───────────────────────────────────────────────────────────
 * Grants are read from the database on each request rather than from the JWT. A token
 * lives for fifteen minutes; revoking a capability has to take effect now, not when
 * somebody's session happens to expire. That is the whole point of being able to take a
 * duty away — and for back-office traffic, which is a handful of requests per minute from
 * a handful of people, one indexed lookup is not a cost worth optimising away.
 *
 * A super admin is recognised by ROLE, not by holding every grant. Grants can be revoked;
 * an installation whose last super admin has had `ADMIN_MANAGE` removed is one nobody can
 * repair, so the recovery path is deliberately not something that can be locked away.
 */
@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<AdminPermission[]>(ADMIN_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // No requirement declared means this route is not permission-gated. The route is still
    // behind @Roles; see the admin-surface test, which is what stops a new admin route from
    // quietly shipping with no capability attached at all.
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as RequestUser | undefined;
    if (!user) {
      throw new AppException(
        ErrorCodes.UNAUTHORIZED,
        'Authentication required.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const rows = await this.prisma.adminGrant.findMany({
      where: { userId: user.id },
      select: { permission: true },
    });
    const held = permissionsFor(
      user.roles,
      rows.map((r) => r.permission as AdminPermission),
    );

    // EVERY listed capability is required, not any of them. A route that needs two
    // capabilities needs both — reading it as "any" would let the weaker one open the door,
    // which is precisely backwards for the split this model exists to create.
    const missing = required.filter((p) => !held.has(p));
    if (missing.length > 0) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Your account does not have permission to do that.',
        HttpStatus.FORBIDDEN,
        { required: missing },
      );
    }
    return true;
  }
}
