import { Injectable, Logger } from '@nestjs/common';
import type { CinemaPricingPolicyStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  resolvePolicy,
  type PolicyContext,
  type PolicyResolution,
  type PolicyRow,
} from './cinema-pricing-policy.resolver';
import { applyPolicy, checkTicketPrice, type PolicyEffect } from './apply-policy';

/**
 * The one place the platform asks "what may this cinema charge, and on whose authority?".
 *
 * ── WHAT LIVES HERE AND WHAT DOES NOT ──────────────────────────────────────────────
 * This loads rows and hands them to a pure resolver. It holds no rule of its own, no state
 * name, and no amount. That separation is what lets precedence, effective dating, ambiguity
 * and the fail-closed behaviour all be tested without a database or a booking.
 *
 * ── WHERE A CINEMA'S JURISDICTION COMES FROM ───────────────────────────────────────
 * The cinema's own columns first, then its linked venue. A cinema may be created before its
 * venue is attached, and a venue may be shared by several cinemas that are classified
 * differently — so the cinema wins where it has an answer, and the venue fills the gaps.
 */
@Injectable()
export class CinemaPricingPolicyService {
  private readonly log = new Logger('CinemaPricingPolicy');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every policy that could price something right now.
   *
   * ACTIVE only. DRAFT prices nothing — that is the entire point of a draft — DISABLED has
   * been withdrawn, and SUPERSEDED is history that bookings already carry their own copy of.
   */
  private async activePolicies(country: string | null): Promise<PolicyRow[]> {
    const rows = await this.prisma.cinemaPricingPolicy.findMany({
      where: {
        status: 'ACTIVE' satisfies CinemaPricingPolicyStatus,
        // Narrowed in SQL where we can; the resolver still checks it, because '*' rows also
        // match and the wildcard is not expressible as an equality here.
        ...(country ? { OR: [{ country: '*' }, { country }] } : {}),
      },
    });
    return rows as unknown as PolicyRow[];
  }

  /** Resolve for a context the caller has already assembled. */
  async resolve(ctx: PolicyContext): Promise<PolicyResolution> {
    return resolvePolicy(await this.activePolicies(ctx.country), ctx);
  }

  /**
   * Resolve for a cinema, at a business date, for a cart of seat categories.
   *
   * `at` is passed in rather than read from a clock here: a quote and the booking that
   * follows it must resolve the SAME policy, and two calls to `new Date()` either side of a
   * checkout can straddle a policy change at midnight.
   */
  async resolveForCinema(
    cinema: {
      country: string | null;
      region: string | null;
      district: string | null;
      city: string | null;
      localBodyType: PolicyContext['localBodyType'];
      cinemaFormat: PolicyContext['cinemaFormat'];
      climateType: PolicyContext['climateType'];
      venue?: { country: string | null; region: string | null; city: string | null } | null;
    },
    currency: string,
    seatCategories: string[],
    at: Date,
  ): Promise<PolicyResolution> {
    return this.resolve({
      country: cinema.country ?? cinema.venue?.country ?? null,
      region: cinema.region ?? cinema.venue?.region ?? null,
      district: cinema.district ?? null,
      city: cinema.city ?? cinema.venue?.city ?? null,
      currency,
      localBodyType: cinema.localBodyType,
      cinemaFormat: cinema.cinemaFormat,
      climateType: cinema.climateType,
      seatCategories,
      at,
    });
  }

  /** The money that follows from a resolution, for `ticketCount` tickets. */
  effectOf(resolution: PolicyResolution, ticketCount: number): PolicyEffect {
    return applyPolicy(resolution, ticketCount);
  }

  /** Whether an organizer's unit price is inside the resolved band. */
  checkPrice(resolution: PolicyResolution, unitPriceMinor: number) {
    return checkTicketPrice(resolution, unitPriceMinor);
  }

  /**
   * A structured line for the audit trail of one priced order.
   *
   * Deliberately answers the questions an auditor actually asks — which policy, why, which
   * version, what reference — rather than dumping the row. No amounts a customer paid and
   * nothing from a payment provider goes near this.
   */
  auditFor(resolution: PolicyResolution, ctx: PolicyContext): Record<string, unknown> {
    return {
      complianceStatus: resolution.status,
      policyId: resolution.policy?.id ?? null,
      policyVersion: resolution.policy?.version ?? null,
      regulatoryReference: resolution.policy?.regulatoryReference ?? null,
      effectiveFrom: resolution.policy?.effectiveFrom?.toISOString() ?? null,
      matchedOn: resolution.explanation,
      jurisdiction: {
        country: ctx.country,
        region: ctx.region,
        district: ctx.district,
        city: ctx.city,
        localBodyType: ctx.localBodyType,
        cinemaFormat: ctx.cinemaFormat,
        climateType: ctx.climateType,
      },
    };
  }

  /**
   * Log a resolution that is not straightforwardly compliant.
   *
   * Warn rather than error for REQUIRES_APPROVAL: it is an expected posture for a market
   * whose order has not been read yet, not an incident. The blocking outcomes are logged at
   * error because somebody has to go and fix data before that cinema can sell.
   */
  logResolution(resolution: PolicyResolution, ctx: PolicyContext): void {
    if (resolution.status === 'COMPLIANT' || resolution.status === 'NOT_REGULATED') return;
    const where = [ctx.country, ctx.region, ctx.city].filter(Boolean).join('/');
    const line = `${resolution.status} for ${where}: ${resolution.explanation}`;
    if (resolution.status === 'REQUIRES_APPROVAL') this.log.warn(line);
    else this.log.error(line);
  }
}
