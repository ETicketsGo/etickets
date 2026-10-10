import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@eticketsgo/shared-types';
import type { Request } from 'express';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { OrgAccessService } from './org-access.service';

export const ORGANIZER_ONLY_KEY = 'organizerOnly';

/**
 * An organizer operation platform staff may never perform on an organization's behalf.
 *
 * For the money and identity routes - the payout bank account, raising a payout, recording
 * cash, legal identity, linking a Stripe or Razorpay account, the organization's receipts and
 * refunds. `OrgAccessService` already refuses staff who are not members (no platform policy is
 * named for any of these); this refuses them at the door instead, before the handler runs, and
 * writes the attempt to the audit log. The staff equivalents, where they exist, are on `/admin`
 * behind their own capabilities (payout accounts: PAYOUT_MANAGE; legal identity:
 * ORGANIZER_REVIEW).
 *
 * The argument names the operation in the audit row.
 */
export const OrganizerOnly = (operation: string) => SetMetadata(ORGANIZER_ONLY_KEY, operation);

/** Global roles an organization's own people carry. */
const ORGANIZER_ROLES: readonly string[] = [
  Role.ORGANIZER_OWNER,
  Role.ORGANIZER_MANAGER,
  Role.CHECKIN_STAFF,
];

/**
 * Enforces {@link OrganizerOnly}. Runs before RolesGuard, so the refusal is recorded rather
 * than lost as a plain role mismatch.
 *
 * A staff account that ALSO carries an organizer role (somebody who registered an organization
 * of their own) is let through to the handler, where membership of the TARGET organization is
 * asserted from the resource - so it can work its own organization and no other.
 */
@Injectable()
export class OrganizerOnlyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: OrgAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const operation = this.reflector.getAllAndOverride<string | undefined>(ORGANIZER_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!operation) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const user = req.user;
    // Unauthenticated callers are JwtAuthGuard's to refuse; organizers are RolesGuard's.
    if (!user || !this.access.isPlatformAdmin(user)) return true;
    if (user.roles.some((r) => ORGANIZER_ROLES.includes(r))) return true;

    /*
      The organization the request NAMES, recorded as named. It is not trusted for anything:
      the request is refused whatever it says, and where the route takes a resource instead
      (a booking for cash) the resource id is recorded and the organization is left empty
      rather than guessed.
    */
    const named =
      pick(req.params, 'organizerId') ??
      pick(req.params, 'organizationId') ??
      pick(req.body, 'organizationId') ??
      pick(req.query, 'organizationId') ??
      (req.path.includes('/organizations/') ? pick(req.params, 'id') : undefined);
    const resource = pick(req.params, 'bookingId');
    await this.access.recordPlatformRefusal(user, {
      organizationId: named ?? null,
      entityType: named ? 'Organization' : resource ? 'Booking' : 'Route',
      entityId: named ?? resource ?? operation,
      operation,
    });
    throw new AppException(
      ErrorCodes.FORBIDDEN,
      'Platform staff cannot do this for an organization. Only its own team can.',
      HttpStatus.FORBIDDEN,
      { operation },
    );
  }
}

function pick(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
