import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@eticketsgo/shared-types';

export const ROLES_KEY = 'roles';
/** Restrict a route to the given platform/organization roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const IS_PUBLIC_KEY = 'isPublic';
/** Mark a route as accessible without authentication. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface RequestUser {
  id: string;
  email: string;
  fullName: string;
  roles: Role[];
}

/** Injects the authenticated user (populated by JwtStrategy). */
export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as RequestUser | undefined;
    return data && user ? user[data] : user;
  },
);
