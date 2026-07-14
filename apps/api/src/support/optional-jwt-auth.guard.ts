import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { RequestUser } from '../common/decorators';

/**
 * Attaches the authenticated user when a valid bearer token is present, but
 * never rejects the request when it is missing or invalid. Use on @Public()
 * routes that personalise behaviour for signed-in callers (e.g. attaching the
 * user's id/email to a support submission) while still serving anonymous ones.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // Ignore auth failures — the route is public.
    }
    return true;
  }

  override handleRequest<TUser = RequestUser>(_err: unknown, user: TUser): TUser {
    // Passport yields `false` when no/invalid token; normalise to undefined and
    // never throw so anonymous callers pass through.
    return (user || undefined) as TUser;
  }
}
