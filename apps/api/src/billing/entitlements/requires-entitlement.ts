import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { EntitlementKey, Role } from '@eticketsgo/shared-types';
import { OrgAccessService } from '../../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';
import { EntitlementService } from './entitlement.service';

export const ENTITLEMENT_KEY = 'requiredEntitlement';

export interface RequiredEntitlement {
  key: EntitlementKey;
  /** The route parameter holding the organization id. Default `organizationId`, then `id`. */
  orgParam?: string;
  /** Organization roles allowed, passed to the membership check. */
  roles?: Role[];
}

/**
 * The organization in the route must have this entitlement, checked on the SERVER.
 *
 * Membership first, then the entitlement: a non-member is refused as a non-member (the same
 * answer as every other organizer route) and never learns which plan another organization is on.
 * Hiding a button in the console is UX; this is the rule.
 */
export const RequiresEntitlement = (key: EntitlementKey, opts: Omit<RequiredEntitlement, 'key'> = {}) =>
  applyDecorators(
    SetMetadata(ENTITLEMENT_KEY, { key, ...opts } satisfies RequiredEntitlement),
    UseGuards(EntitlementGuard),
  );

@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: OrgAccessService,
    private readonly entitlements: EntitlementService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredEntitlement | undefined>(
      ENTITLEMENT_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required) return true;
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as RequestUser | undefined;
    const params = (req.params ?? {}) as Record<string, string | undefined>;
    const organizationId = required.orgParam
      ? params[required.orgParam]
      : (params.organizationId ?? params.id);
    if (!user || !organizationId) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'This needs a signed-in member of the organization.',
        HttpStatus.FORBIDDEN,
      );
    }
    await this.access.assertMember(user, organizationId, required.roles);
    await this.entitlements.assert(organizationId, required.key);
    return true;
  }
}
