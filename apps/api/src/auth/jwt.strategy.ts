import { HttpStatus, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { MemberStatus, Role, UserStatus } from '@eticketsgo/shared-types';
import type { RequestUser } from '../common/decorators';
import { AppException } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { MfaService } from './mfa/mfa.service';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  name: string;
  roles: Role[];
  /**
   * Second-factor claims. Present only on a session that passed MFA; `mfaCid` names the
   * authenticator it passed against and `mfaAt` is when (epoch seconds). Neither is trusted on
   * its own: the strategy checks `mfaCid` against the database on every request.
   */
  amr?: string[];
  mfaCid?: string;
  mfaAt?: number;
  /** Issued-at, epoch seconds, added by the signer. Compared with a team removal below. */
  iat?: number;
}

/**
 * The code a session gets when a team removal ended it.
 *
 * Its own code rather than a bare UNAUTHORIZED, so a console can tell the person what happened
 * ("You no longer have access to ...") instead of an unexplained sign-in page.
 */
export const ACCESS_REMOVED = 'ACCESS_REMOVED';

/**
 * The organization whose removal ended this token's session, or null when none did.
 *
 * Mirrors OrganizationsService.removeMember: a removal signs the person out everywhere only
 * when it took their LAST active seat and they are not platform staff. It revokes their
 * refresh tokens, but the access token they already hold is a stateless JWT, valid until it
 * expires (JWT_ACCESS_TTL, 900s). For those minutes the account kept working as a plain
 * customer, so the console's open tab saw no organizer role and sent them to "Set up your
 * organization" - just after the removal said "signed out everywhere".
 *
 * The removal time is the REMOVED seat's `updatedAt`: removal is the last write to a REMOVED
 * row (inviting them again moves it back to INVITED, and a role change refuses a removed
 * member). A token issued before it is refused; one issued after it is a session they started
 * again by signing in, and passes. `iat` is whole seconds, so a token from the same second as
 * the removal counts as older and is refused - the safe side.
 */
export function removedSessionOrg(
  iat: number | undefined,
  globalRoles: Role[],
  seats: { status?: string; updatedAt?: Date; organizationId?: string }[],
): string | null {
  if (typeof iat !== 'number') return null;
  if (globalRoles.some((r) => r === Role.ADMIN || r === Role.SUPER_ADMIN)) return null;
  if (seats.some((s) => s.status === MemberStatus.ACTIVE)) return null;
  let latest: { updatedAt: Date; organizationId?: string } | null = null;
  for (const s of seats) {
    if (s.status !== MemberStatus.REMOVED || !s.updatedAt) continue;
    if (!latest || s.updatedAt > latest.updatedAt) {
      latest = { updatedAt: s.updatedAt, organizationId: s.organizationId };
    }
  }
  if (!latest || iat * 1000 > latest.updatedAt.getTime()) return null;
  return latest.organizationId ?? '';
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
    /*
      Last and optional, the codebase's rule for a new dependency (see AuthService). The running
      application always has it; a harness that builds the strategy by hand gets "MFA dormant".
    */
    @Optional() private readonly mfa?: MfaService,
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
    // who is removed or demoted loses the grant on their very next call. REMOVED seats come
    // back in the same query (no extra round trip) so a session that a removal ended can be
    // refused here, rather than carried on as a customer until the token expires.
    const rows = await this.prisma.organizationMember.findMany({
      where: { userId: user.id, status: { in: [MemberStatus.ACTIVE, MemberStatus.REMOVED] } },
      select: { role: true, status: true, updatedAt: true, organizationId: true },
    });
    const seats = rows.filter((s) => s.status !== MemberStatus.REMOVED);

    const removedFrom = removedSessionOrg(payload.iat, user.roles as Role[], rows);
    if (removedFrom !== null) {
      // Only on this rare path: the name is for the message the person is about to read.
      const org = removedFrom
        ? await this.prisma.organization.findUnique({
            where: { id: removedFrom },
            select: { name: true },
          })
        : null;
      throw new AppException(
        ACCESS_REMOVED,
        org?.name
          ? `You no longer have access to ${org.name}.`
          : 'You no longer have access to this organization.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    /*
      Second-factor state is judged on the account's GLOBAL roles, read just now from the
      database, never on the token and never on seat roles: ADMIN/SUPER_ADMIN come only from the
      user row, and a token minted before somebody became an administrator carries no claim and
      so is refused on every admin route until they sign in through the second factor.
    */
    const mfa = this.mfa
      ? await this.mfa.sessionState(user.id, user.roles as Role[], {
          mfaCid: payload.mfaCid,
          mfaAt: payload.mfaAt,
        })
      : { required: false, enrolled: false, verified: false, verifiedAt: null };

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: effectiveRoles(
        user.roles as Role[],
        seats.map((s) => s.role as Role),
      ),
      mfa,
    };
  }
}
