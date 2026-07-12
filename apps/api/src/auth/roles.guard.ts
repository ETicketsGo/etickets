import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@eticketsgo/shared-types';
import { ROLES_KEY } from '../common/decorators';
import type { RequestUser } from '../common/decorators';
import { AppException, ErrorCodes } from '../common/errors';

/** Enforces @Roles(...) — the user must hold at least one required role. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as RequestUser | undefined;
    if (!user) {
      throw new AppException(
        ErrorCodes.UNAUTHORIZED,
        'Authentication required.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const ok = user.roles.some((r) => required.includes(r));
    if (!ok) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You do not have permission to perform this action.',
        HttpStatus.FORBIDDEN,
        { requiredRoles: required },
      );
    }
    return true;
  }
}
