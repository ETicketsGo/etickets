import { HttpStatus, Injectable } from '@nestjs/common';
import { Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { SaleEligibilityService } from '../pricing/cinema-policy/sale-eligibility.service';
import type { SaleBlockerCode } from '../pricing/cinema-policy/sale-eligibility';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/** The same roles that may read the calendar these shows come from. */
const ELIGIBILITY_ROLES = [Role.ORGANIZER_OWNER, Role.ORGANIZER_MANAGER];

/** Shows per request. The Overview asks about one week's programme, which it caps at a handful. */
export const SALE_ELIGIBILITY_MAX_SESSIONS = 50;

export interface OrganizerSessionSaleEligibility {
  sessionId: string;
  /**
   * Whether a buyer can complete a purchase for anything on this show right now: the
   * storefront's `onlineBooking.open`, from the same function. False only when nothing sells.
   */
  open: boolean;
  /** False when any ticket type is refused, even if others sell. */
  sellable: boolean;
  blockers: {
    code: SaleBlockerCode;
    owner: 'ORGANIZER' | 'PLATFORM';
    /** The organizer's sentence: what is wrong and what to do. */
    message: string;
    fixPath: string | null;
    subject?: string;
  }[];
}

/**
 * Whether checkout would sell each of an organization's shows, for the organizer Overview.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────
 * The Overview said "Selling" from `GET /events/:id/sellability`, which checks configuration -
 * dates, ticket types, seat classes - and does NOT ask the sale-eligibility rules checkout
 * refuses a cart by (#280). So a Telangana cinema show with no state price rules read
 * "Selling" on the dashboard while every checkout answered 409 SALE_NOT_OPEN. That is the one
 * thing the console must never claim.
 *
 * The readings that do consult those rules were each the wrong shape: the public show summary
 * (`onlineBooking`) is per show, unauthenticated and deliberately carries no reason; the
 * cinema readiness page is per cinema, and an event's shows can sit in several. So this is one
 * read-only, organization-scoped request for the handful of shows on screen, answered by
 * `SaleEligibilityService.forSession` - the very function checkout and the storefront use -
 * with the organizer's own sentence for each refusal. It decides nothing itself.
 *
 * A show of another organization is not answered (and not distinguished from one that does
 * not exist), so the ids cannot be used to probe somebody else's programme.
 */
@Injectable()
export class OrganizerSaleEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly eligibility: SaleEligibilityService,
  ) {}

  async forSessions(
    user: RequestUser,
    organizationId: string,
    sessionIds: string[],
  ): Promise<{ sessions: OrganizerSessionSaleEligibility[] }> {
    await this.access.assertMember(user, organizationId, ELIGIBILITY_ROLES);
    const ids = [...new Set(sessionIds)];
    if (ids.length > SALE_ELIGIBILITY_MAX_SESSIONS) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `Ask about at most ${SALE_ELIGIBILITY_MAX_SESSIONS} shows at a time.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (ids.length === 0) return { sessions: [] };

    const owned = await this.prisma.eventSession.findMany({
      where: { id: { in: ids }, event: { organizationId } },
      select: { id: true },
    });

    const at = new Date();
    const sessions: OrganizerSessionSaleEligibility[] = [];
    for (const { id } of owned) {
      const verdict = await this.eligibility.forSession(id, at);
      sessions.push({
        sessionId: id,
        open: verdict.sellable || verdict.sellableTicketTypeIds.length > 0,
        sellable: verdict.sellable,
        blockers: verdict.blockers.map((b) => ({
          code: b.code,
          owner: b.owner,
          message: b.organizerMessage,
          fixPath: b.fixPath,
          ...(b.subject ? { subject: b.subject } : {}),
        })),
      });
    }
    return { sessions };
  }
}
