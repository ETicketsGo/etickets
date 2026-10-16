import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

/**
 * Attaches the authenticated user when the caller sends a bearer token, and lets a caller who
 * sends none through as anonymous. Use on @Public() routes that personalise behaviour for
 * signed-in callers (e.g. attaching the user's id/email to a support submission) while still
 * serving anonymous ones.
 *
 * A token that is PRESENT but no longer good (expired, revoked, account suspended) is refused
 * with 401, exactly as on any authenticated route. This guard used to swallow that failure and
 * carry on as anonymous. The organizer console sends support requests without an email field,
 * because a signed-in person's email is known; once the page had been open longer than the
 * access token lives (JWT_ACCESS_TTL, 900s) the send was judged anonymous and refused with
 * "An email address is required so we can reply." The web client already refreshes and
 * retries on a 401, but a 400 never gave it the chance. Anonymous means "no credential", not
 * "a credential that failed".
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!hasBearer(req.headers.authorization)) return true;
    // Passport's default handleRequest throws on a failed token, so this either attaches the
    // user or answers 401.
    return (await super.canActivate(context)) as boolean;
  }
}

/** Only a bearer credential is a claim to be somebody; any other header is ignored. */
export function hasBearer(header: string | undefined): boolean {
  return typeof header === 'string' && /^Bearer\s+\S/i.test(header);
}
