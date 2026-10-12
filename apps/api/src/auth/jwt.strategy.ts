import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { MemberStatus, Role, UserStatus } from '@eticketsgo/shared-types';
import type { RequestUser } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  name: string;
  roles: Role[];
}

/** The only membership roles that map onto a route-level role. */
const SEAT_ROLES: ReadonlySet<Role> = new Set([
  Role.ORGANIZER_OWNER,
  Role.ORGANIZER_MANAGER,
  Role.CHECKIN_STAFF,
]);

/**
 * Global roles UNION the roles of ACTIVE team seats.
 *
 * An invited teammate is created with global roles [CUSTOMER] only, so @Roles(CHECKIN_STAFF,
 * ...) refused every real invitee; only seeded accounts, whose global role was set by hand,
 * worked. This is the single place that closes the gap. It widens only the coarse @Roles
 * door: which organization the caller may touch is still decided per route by
 * OrgAccessService, so a seat in org A opens nothing in org B. Nothing is written back to
 * the user row (see OrganizationsService.create, which must not persist this union).
 */
export function effectiveRoles(global: Role[], seats: Role[]): Role[] {
  return [...new Set([...global, ...seats.filter((r) => SEAT_ROLES.has(r))])];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  /**
   * Verify the signature AND that the account is still allowed to act.
   *
   * This previously trusted the token payload alone, so account state was only ever
   * consulted at sign-in. Two real consequences:
   *
   *   - Someone who deleted their account kept full access for the remaining lifetime
   *     of their access token (JWT_ACCESS_TTL, 900s by default). "Delete my account"
   *     that leaves the account usable for fifteen minutes is not deletion, and both
   *     app stores treat it as a compliance requirement rather than a nicety.
   *   - UserStatus.SUSPENDED was enforced NOWHERE. Suspending an abusive account changed
   *     a column and nothing else, because nothing ever re-read it. That was a latent
   *     hole, unrelated to deletion, that this closes as a side effect.
   *
   * The cost is one primary-key lookup per authenticated request — the standard trade
   * for revocable sessions with stateless tokens, and the cheapest query the database
   * can be asked to run. It is deliberately NOT cached: a cache would reintroduce
   * exactly the staleness window being closed here.
   *
   * Roles are read from the DATABASE rather than the token, for the same reason: a role
   * revoked mid-session should take effect on the next request, not the next sign-in.
   */
  async validate(payload: AccessTokenPayload): Promise<RequestUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, fullName: true, roles: true, status: true },
    });

    // A deleted account and a suspended one are rejected identically, and neither
    // response tells the caller which it was.
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException();
    }

    // Roles held through a TEAM seat. Read per request, like the global roles, so a member
    // who is removed or demoted loses the grant on their very next call.
    const seats = await this.prisma.organizationMember.findMany({
      where: { userId: user.id, status: MemberStatus.ACTIVE },
      select: { role: true },
    });

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: effectiveRoles(
        user.roles as Role[],
        seats.map((s) => s.role as Role),
      ),
    };
  }
}
