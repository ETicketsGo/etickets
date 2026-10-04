import { HttpStatus, Injectable } from '@nestjs/common';
import { Role } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { platformFinanceEntry } from './platform-finance.producer';
import { providerFinanceEntry } from './provider-finance.producer';
import { composeFinance, type ComposedFinance } from './unified-finance.composer';

/**
 * The organizer-facing Finance read path.
 *
 * ── READ ONLY, AND STRUCTURALLY SO ─────────────────────────────────────────────────
 * It creates no payout, modifies no settlement, touches no allocation, calls no provider, runs no
 * reconciliation and moves no money. The only Prisma calls are `findMany`. Everything financial is
 * decided by the two certified producers and arranged by the pure composer; this fetches and
 * delegates.
 *
 * ── AUTHORIZATION HAPPENS BEFORE THE FIRST QUERY ───────────────────────────────────
 * Not around the result. `assertMember` runs before anything is read, and an event scope is
 * checked to belong to the asserted organization before it is used in a filter. The alternative -
 * fetch broadly, filter afterwards - means unauthorized financial evidence exists in memory and
 * one forgotten filter away from a response. Authorization is part of financial correctness here,
 * not a wrapper around it.
 *
 * ── WHY THIS SITS BESIDE /payouts/summary RATHER THAN REPLACING IT ─────────────────
 * They answer different questions. `/payouts/summary` is forward-looking: what a payout raised
 * right now would come to, computed from current booking state. This is historical: which
 * financial records exist, what they say, and which path owns them. Folding the second into the
 * first would make a live projection carry immutable evidence.
 */
@Injectable()
export class UnifiedFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
  ) {}

  /**
   * Every financial record this organization has, grouped by currency.
   *
   * `eventId` narrows to one event's authoritative participation, which for a period payout means
   * its allocations - so a payout with `eventId: null` is still found when its allocations prove
   * the event took part.
   */
  async forOrganization(
    user: RequestUser,
    organizationId: string,
    eventId?: string,
  ): Promise<ComposedFinance> {
    // FIRST. Nothing financial is read until this returns.
    await this.access.assertMember(user, organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);

    if (eventId !== undefined) {
      /*
        An event id from another organization must be refused, not quietly ignored. Ignoring it
        would answer the organization-wide question instead and leak nothing - but it would also
        let a caller probe which ids exist by watching whether the scope narrowed. Refusing is the
        same answer whether the event is absent or somebody else's.
      */
      const owned = await this.prisma.event.findFirst({
        where: { id: eventId, organizationId },
        select: { id: true },
      });
      if (!owned) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'Event not found for this organization.',
          HttpStatus.NOT_FOUND,
        );
      }
    }

    const [platform, provider] = await Promise.all([
      this.platformEntries(organizationId, eventId),
      this.providerEntries(organizationId, eventId),
    ]);

    return composeFinance({ platform, provider });
  }

  /** Payouts and their allocations, scoped to the asserted organization. */
  private async platformEntries(organizationId: string, eventId?: string) {
    /*
      Event scope on the PAYOUT side has two shapes, and missing the second is the bug this whole
      track exists to prevent: an event-scoped payout names the event on the row, and a period
      payout proves it through allocations. A filter on `eventId` alone would silently drop every
      period payout that covered the event.
    */
    const where =
      eventId === undefined
        ? { organizationId }
        : {
            organizationId,
            OR: [{ eventId }, { allocations: { some: { eventId } } }],
          };

    const payouts = await this.prisma.payout.findMany({
      where,
      select: {
        id: true,
        organizationId: true,
        eventId: true,
        currency: true,
        status: true,
        periodStart: true,
        periodEnd: true,
        grossMinor: true,
        bookingFeeMinor: true,
        paymentFeeMinor: true,
        refundMinor: true,
        netMinor: true,
        allocatedFrom: true,
        /*
          EVERY allocation, not only those for the scoped event. The producer reconciles the
          allocation sums against the stored totals, and a filtered subset would disagree with
          them by construction - manufacturing an integrity finding out of a scoping decision.
        */
        allocations: {
          select: {
            bookingId: true,
            eventId: true,
            currency: true,
            allocatedNetMinor: true,
            subtotalMinor: true,
            discountMinor: true,
            organizerFeeMinor: true,
            refundShareMinor: true,
            bookingFeeMinor: true,
            paymentFeeMinor: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return payouts.map((payout) => {
      const { allocations, ...row } = payout;
      return platformFinanceEntry(row, allocations);
    });
  }

  /** OPEN reconciliation findings per settlement. Empty in, empty out - no query for no rows. */
  private async openFindingCounts(settlementIds: string[]): Promise<Map<string, number>> {
    if (settlementIds.length === 0) return new Map();
    const rows = await this.prisma.settlementReconciliationFinding.groupBy({
      by: ['settlementId'],
      where: { settlementId: { in: settlementIds }, status: 'OPEN' },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.settlementId, r._count._all]));
  }

  /** Settlements and their reconciliation evidence, scoped to the asserted organization. */
  private async providerEntries(organizationId: string, eventId?: string) {
    const settlements = await this.prisma.settlement.findMany({
      where: { organizationId, ...(eventId !== undefined ? { eventId } : {}) },
      select: {
        id: true,
        organizationId: true,
        eventId: true,
        currency: true,
        status: true,
        grossSalesMinor: true,
        platformFeesMinor: true,
        refundsMinor: true,
        disputesMinor: true,
        reserveMinor: true,
        releasedMinor: true,
        transferredMinor: true,
        createdAt: true,
        updatedAt: true,
        /*
          Only what decides whether ambiguity exists. The producer does not re-derive money from
          attempt rows - the settlement's own ledger already reflects confirmed reversals and
          nothing else - so the statuses are all that is needed.
        */
        reversalAttempts: {
          where: { status: { in: ['REQUESTED', 'PROCESSING', 'UNKNOWN'] } },
          select: { id: true },
        },
        /*
          UNKNOWN only, deliberately.

          A transfer attempt sits in REQUESTED for the duration of every ordinary provider call,
          so counting that state would raise an alarm on healthy releases that happen to overlap
          a read. UNKNOWN is different: it is written when the outcome could not be established,
          which means the organizer may already hold money we cannot account for. That is
          unambiguous and it is exactly what "somebody must look at this" is for.

          A REQUESTED row left behind by a crash is a real problem too, but distinguishing stale
          from in-flight needs a staleness window, which belongs to a sweeper rather than to a
          read model. There is no transfer sweeper yet; see
          docs/guides/PROVIDER-EXECUTION-AND-RECONCILIATION.md.
        */
        transferAttempts: {
          where: { status: 'UNKNOWN' },
          select: { id: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    /*
      One grouped query for every settlement in the page, rather than a relation load per row.
      This is what `reconciliationMismatch` was reaching for and could never express: whether a
      reconciliation problem is CURRENTLY open, derived from the durable finding rather than
      stored a second time where it could go stale.
    */
    const openBySettlement = await this.openFindingCounts(settlements.map((s) => s.id));

    return settlements.map((settlement) => {
      const { reversalAttempts, transferAttempts, ...row } = settlement;
      return providerFinanceEntry(row, {
        /*
          Both directions. Money that may have gone OUT without us learning the outcome is at
          least as strong a reason to call somebody as money that may not have come back, and
          until the transfer attempt table existed there was no durable evidence of it at all.
        */
        unresolvedCount: reversalAttempts.length + transferAttempts.length,
        openFindingCount: openBySettlement.get(settlement.id) ?? 0,
      });
    });
  }
}
