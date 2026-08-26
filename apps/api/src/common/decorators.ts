import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AdminPermission, Role } from '@eticketsgo/shared-types';

export const ROLES_KEY = 'roles';
/**
 * Metadata key for the back-office capability a route requires.
 *
 * Declared here beside ROLES_KEY rather than in the guard, so the decorator does not have
 * to import the guard — which imports this file for RequestUser, and would make a cycle.
 */
export const ADMIN_PERMISSION_KEY = 'adminPermission';
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

/**
 * The back-office capability (or capabilities) a route requires.
 *
 * ALL listed capabilities are required, not any of them — a route needing two needs both.
 * Reading it as "any" would let the weaker capability open the door, which is backwards for
 * the whole point of separating duties.
 */
export const RequiresAdmin = (...permissions: AdminPermission[]) =>
  SetMetadata(ADMIN_PERMISSION_KEY, permissions);
