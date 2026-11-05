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

/**
 * What this request's session proved about the second factor. Computed per request by
 * JwtStrategy from the signed token AND the database, never from the token alone.
 */
export interface MfaSessionState {
  /**
   * The session must have passed the second factor to use ANY back-office route. True for
   * back-office accounts while MFA is armed (MFA_ENCRYPTION_KEY set), except that with
   * MFA_ENROLLMENT=deferred it is true only once the account has enrolled.
   */
  required: boolean;
  /** The account has a confirmed authenticator. */
  enrolled: boolean;
  /** This session passed the second factor against the CURRENT authenticator. */
  verified: boolean;
  /** Epoch ms of the check this session last made; null when not verified. */
  verifiedAt: number | null;
  /**
   * What a @RequiresRecentMfa route can expect of this server, for back-office accounts:
   *   'available'    - a key is configured: enroll, prove a code, and the route opens;
   *   'unconfigured' - no MFA_ENCRYPTION_KEY: nothing can be enrolled, so the route is refused;
   *   'dormant'      - LOCAL/DEV, no key, MFA_ENROLLMENT=required: MFA is simply not armed on
   *                    this machine and the check is skipped (laptops and the test suite).
   * Absent (customers, organizers, a state built by hand) reads as 'unconfigured': the guard
   * fails closed for staff.
   */
  stepUp?: 'available' | 'unconfigured' | 'dormant';
}

export interface RequestUser {
  id: string;
  email: string;
  fullName: string;
  roles: Role[];
  mfa?: MfaSessionState;
}

export const MFA_PENDING_KEY = 'mfaPendingAllowed';
/**
 * The few routes a back-office session may call BEFORE it has passed the second factor:
 * enrolling, reading its own MFA state, and signing out. Everything else refuses it.
 */
export const AllowMfaPending = () => SetMetadata(MFA_PENDING_KEY, true);

export const MFA_RECENT_KEY = 'mfaRecentRequired';
/**
 * Step-up: the route also needs a second-factor check made within MFA_STEPUP_MINUTES, so a
 * session left open on an unlocked machine cannot move money or change who has power.
 */
export const RequiresRecentMfa = () => SetMetadata(MFA_RECENT_KEY, true);

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
