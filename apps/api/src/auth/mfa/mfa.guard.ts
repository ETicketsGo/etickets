import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  MFA_PENDING_KEY,
  MFA_RECENT_KEY,
  type RequestUser,
} from '../../common/decorators';
import { AppException, ErrorCodes } from '../../common/errors';
import { MfaService, isStaff } from './mfa.service';

/**
 * The one place admin MFA is enforced, for EVERY authenticated route.
 *
 * ── WHY IT KEYS ON THE ACCOUNT AND NOT ON THE DECORATORS ───────────────────────────
 * The obvious design - check the claim wherever `@Roles(ADMIN)` or `@RequiresAdmin` appears -
 * leaves every other route open to a back-office session that never passed the second factor
 * (an admin who is also an organizer, a route that forgot its decorator, one added next year).
 * So the question asked here is "is the caller back-office staff?", answered from the DATABASE
 * roles that JwtStrategy already loaded, and if so the session must have passed MFA. Routes
 * that declare `@Roles(ADMIN)` are a subset of that, so they are covered without being named.
 *
 * Fails CLOSED: a staff request with no MFA state at all is refused, not waved through.
 *
 * Dormant (no MFA_ENCRYPTION_KEY) the strategy reports `required: false` and this guard passes
 * everything, which is what lets the deploy that introduces MFA be a no-op until the owner arms it.
 */
@Injectable()
export class MfaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly mfa: MfaService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const user = context.switchToHttp().getRequest().user as RequestUser | undefined;
    // No user means JwtAuthGuard already refused or this is a public route; nothing to judge.
    if (!user) return true;
    if (!isStaff(user.roles)) return true;

    const state = user.mfa;
    if (state && !state.required) return true; // dormant

    const pendingOk = this.reflector.getAllAndOverride<boolean>(MFA_PENDING_KEY, targets);
    if (!state || !state.verified) {
      if (pendingOk) return true;
      throw new AppException(
        ErrorCodes.MFA_REQUIRED,
        state?.enrolled
          ? 'Sign in again and enter your authenticator code.'
          : 'Set up your authenticator to use the admin console.',
        HttpStatus.FORBIDDEN,
        { enrolled: Boolean(state?.enrolled) },
      );
    }

    if (this.reflector.getAllAndOverride<boolean>(MFA_RECENT_KEY, targets)) {
      const at = state.verifiedAt ?? 0;
      if (Date.now() - at > this.mfa.stepUpMs) {
        throw new AppException(
          ErrorCodes.MFA_STEP_UP_REQUIRED,
          'Confirm your authenticator code to do this.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
    return true;
  }
}
