import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  IS_PUBLIC_KEY,
  MFA_PENDING_KEY,
  MFA_RECENT_KEY,
  type RequestUser,
} from '../../common/decorators';
import { AppException, ErrorCodes } from '../../common/errors';
import { requestClientIp } from '../../common/client-ip';
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
 * ── WHEN THE CONSOLE DOES NOT NEED MFA (`required: false`) ─────────────────────────
 * Two ways: MFA_ENROLLMENT=deferred for an account that has not enrolled, or no
 * MFA_ENCRYPTION_KEY at all. Ordinary routes then pass. The step-up routes (@RequiresRecentMfa:
 * money, payment and pricing configuration, who has power) do NOT: they need an enrolled factor
 * checked recently, so they are refused - MFA_SETUP_REQUIRED when the person can fix it by
 * enrolling, MFA_NOT_CONFIGURED when the server has no key and nobody can - and the attempt is
 * audited. Before MFA_ENROLLMENT existed a missing key skipped the step-up check entirely; that
 * survives only on a developer machine (`stepUp: 'dormant'`, LOCAL/DEV in `required` mode).
 */
@Injectable()
export class MfaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly mfa: MfaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const user = req.user;
    // No user means JwtAuthGuard already refused or this is a public route; nothing to judge.
    if (!user) return true;
    if (!isStaff(user.roles)) return true;

    const state = user.mfa;
    const stepUp = Boolean(this.reflector.getAllAndOverride<boolean>(MFA_RECENT_KEY, targets));

    if (state && !state.required) {
      if (!stepUp) return true;
      if (state.stepUp === 'dormant') return true;
      if (state.stepUp !== 'available') {
        await this.refuseRecorded(context, req, user, 'not_configured');
      }
      if (!state.enrolled) await this.refuseRecorded(context, req, user, 'not_enrolled');
      // Enrolled always means `required` today (MfaService.sessionState); if that ever changes,
      // the freshness check below still applies, so the route stays closed without a fresh code.
    } else {
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
    }

    if (stepUp) {
      const at = state?.verifiedAt ?? 0;
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

  /** Audit, then refuse. The audit write never throws (AuditService.record), so this always refuses. */
  private async refuseRecorded(
    context: ExecutionContext,
    req: Request,
    user: RequestUser,
    reason: 'not_enrolled' | 'not_configured',
  ): Promise<never> {
    await this.mfa.recordSensitiveRefusal(
      user.id,
      reason,
      {
        // The handler and the route PATTERN, never the concrete URL: ids and query strings are
        // not what the owner needs to see, and the pattern groups the attempts by action.
        operation: `${context.getClass().name}.${context.getHandler().name}`,
        method: req.method,
        path: (req.route as { path?: string } | undefined)?.path ?? req.path,
      },
      { ip: requestClientIp(req) },
    );
    throw reason === 'not_configured'
      ? new AppException(
          ErrorCodes.MFA_NOT_CONFIGURED,
          'This action is blocked because two-step sign-in is not set up on this server. ' +
            'An operator must turn it on before anyone can do this.',
          HttpStatus.FORBIDDEN,
        )
      : new AppException(
          ErrorCodes.MFA_SETUP_REQUIRED,
          'Set up two-step sign-in before you do this. It takes a minute: you need your password ' +
            'and an authenticator app on your phone.',
          HttpStatus.FORBIDDEN,
          { setupPath: '/enroll-mfa' },
        );
  }
}
