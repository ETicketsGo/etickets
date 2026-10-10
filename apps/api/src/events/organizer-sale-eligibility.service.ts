import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Role,
  type EventSaleState,
  type SaleReason,
  type SaleStateKind,
} from '@eticketsgo/shared-types';
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

/** Events per request: one page of the event list. */
export const SALE_ELIGIBILITY_MAX_EVENTS = 50;

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
  /**
   * The unified answer every organizer screen renders (`sale-state.ts` in shared-types):
   * SELLING, PARTIAL (some ticket types refused) or NOT_SELLING, over everything checkout
   * reads - the event's status, the show's, each ticket type's window and places, and the
   * regulatory check above.
   */
  state: SaleStateKind;
  reasons: SaleReason[];
  openTicketTypeIds: string[];
  closedTicketTypeIds: string[];
  eventId: string;
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
 * `SaleEligibilityService.sessionStates` - `sessionSaleEligibility`, the very function checkout
 * and the storefront use, plus the status, window and places checkout reads - with the
 * organizer's own sentence for each refusal. It decides nothing itself.
 *
 * Every organizer screen now renders `state` from here (2026-10-10): four screens had worked out
 * "selling" four ways and told one organizer three different things about one show.
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

    // Scoped in the query itself: another organization's show is simply not found.
    const answers = await this.eligibility.sessionStates(
      { id: { in: ids }, event: { organizationId } },
      new Date(),
    );
    return {
      sessions: answers.map(({ state, eligibility: verdict }) => ({
        sessionId: state.sessionId,
        open: verdict.sellable || verdict.sellableTicketTypeIds.length > 0,
        sellable: verdict.sellable,
        blockers: verdict.blockers.map((b) => ({
          code: b.code,
          owner: b.owner,
          message: b.organizerMessage,
          fixPath: b.fixPath,
          ...(b.subject ? { subject: b.subject } : {}),
        })),
        eventId: state.eventId,
        state: state.state,
        reasons: state.reasons,
        openTicketTypeIds: state.openTicketTypeIds,
        closedTicketTypeIds: state.closedTicketTypeIds,
      })),
    };
  }

  /**
   * Whether each of an organization's EVENTS is selling, over its upcoming shows, for the
   * event list and the event overview: one chip per event without a request per event.
   *
   * Same roles, same scoping, same refusal to tell another organization's event from one that
   * does not exist. Read-only.
   */
  async forEvents(
    user: RequestUser,
    organizationId: string,
    eventIds: string[],
  ): Promise<{ events: EventSaleState[] }> {
    await this.access.assertMember(user, organizationId, ELIGIBILITY_ROLES);
    const ids = [...new Set(eventIds)];
    if (ids.length > SALE_ELIGIBILITY_MAX_EVENTS) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        `Ask about at most ${SALE_ELIGIBILITY_MAX_EVENTS} events at a time.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (ids.length === 0) return { events: [] };

    const owned = await this.prisma.event.findMany({
      where: { id: { in: ids }, organizationId },
      select: { id: true, status: true, organization: { select: { status: true } } },
    });
    const events = await this.eligibility.eventStates(
      owned.map((e) => ({
        id: e.id,
        status: e.status,
        organizationSuspended: e.organization?.status === 'SUSPENDED',
      })),
      new Date(),
    );
    return { events };
  }
}
