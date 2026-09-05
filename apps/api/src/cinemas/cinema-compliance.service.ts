import { HttpStatus, Injectable } from '@nestjs/common';
import type { PricingComplianceStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { CinemaPricingPolicyService } from '../pricing/cinema-policy/cinema-pricing-policy.service';
import { checkTicketPrice } from '../pricing/cinema-policy/apply-policy';

/**
 * What an organizer is told about the rules their cinema is priced under.
 *
 * ── EXPLANATORY, NEVER ENFORCEMENT ─────────────────────────────────────────────────
 * Everything here is a second reading of a decision the server has already made elsewhere.
 * Booking refuses on its own; the ticket-price ceiling is checked on its own. If this file
 * were deleted, nothing about what may be sold would change — only the organizer's ability
 * to find out WHY before they hit a wall.
 *
 * That separation is deliberate. The moment a compliance screen becomes the thing that
 * decides, a client that fails to call it becomes a client that can sell at any price.
 *
 * ── WHAT AN ORGANIZER IS NOT SHOWN ─────────────────────────────────────────────────
 * `notes` on a policy is internal: it carries things like "transcribed from a brief, not the
 * order text" and "treatment unverified". Useful to whoever configures the platform,
 * actively misleading to an exhibitor deciding whether they may charge ₹150. The citation
 * and the rule are shown; the commentary is not.
 */
export interface ComplianceView {
  /** Where the cinema is, as the rule engine understands it. */
  jurisdiction: {
    country: string | null;
    region: string | null;
    district: string | null;
    city: string | null;
    localBodyType: string | null;
  };
  classification: { cinemaFormat: string | null; climateType: string | null };
  status: PricingComplianceStatus;
  /** One sentence an exhibitor can act on. */
  summary: string;
  /** The cited order. Never the internal notes. */
  regulatoryReference: string | null;
  effectiveFrom: string | null;
  maintenance: {
    perTicketMinor: number;
    treatment: string;
    /** Plain words, because "INCLUDED_IN_TICKET_PRICE" is not a sentence. */
    description: string;
  } | null;
  /** Null when the resolved policy states no ceiling — which is not the same as no ceiling. */
  maxTicketPriceMinor: number | null;
  ticketPriceRule: string | null;
  onlineFee: { policy: string; description: string };
  /** Per ticket type, when prices were supplied. */
  prices: {
    ticketTypeId: string;
    name: string;
    priceMinor: number;
    ok: boolean;
    reason: string | null;
  }[];
  /** Whether the server would currently refuse to sell. Reported, not enforced here. */
  blocksPublishing: boolean;
}

@Injectable()
export class CinemaComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly policies: CinemaPricingPolicyService,
    private readonly audit: AuditService,
  ) {}

  async forCinema(
    user: { id: string },
    cinemaId: string,
    at = new Date(),
  ): Promise<ComplianceView> {
    const cinema = await this.prisma.cinema.findUnique({
      where: { id: cinemaId },
      include: { venue: { select: { country: true, region: true, city: true } } },
    });
    if (!cinema) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Cinema not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user as never, cinema.organizationId);

    /*
      Every ticket type on this cinema's screens, with its seat class. The seat class is what
      the rate table bands on — a Municipal Corporation multiplex is ₹150 regular and ₹250
      recliner — so a compliance answer that ignored it would be answering a different
      question from the one the organizer is asking.
    */
    const ticketTypes = await this.prisma.ticketType.findMany({
      where: { eventSession: { screen: { cinemaId } } },
      select: {
        id: true,
        name: true,
        priceMinor: true,
        seatCategory: { select: { name: true, regulatoryClass: true } },
      },
      take: 200,
    });

    /*
      REGULATORY classes, not display names. The rate rows band on a fixed set of classes an
      order names; what an operator calls a seat is theirs to choose. Passing the display name
      here — which is what this did — meant a category called "Recliner" matched the recliner
      ceiling and one called "Lounger" matched nothing at all.
    */
    const seatCategories = [
      ...new Set(
        ticketTypes
          .map((t) => t.seatCategory?.regulatoryClass)
          .filter((c): c is NonNullable<typeof c> => Boolean(c)),
      ),
    ];
    // Named so the organizer is told WHICH category to map, not merely that one is missing.
    const unmappedSeatCategories = [
      ...new Set(
        ticketTypes
          .filter((t) => t.seatCategory && !t.seatCategory.regulatoryClass)
          .map((t) => t.seatCategory!.name),
      ),
    ];

    /*
      One class resolves to its own row; several resolve at jurisdiction level. Passing every
      class at once matches several equally specific rows and reports them as a configuration
      error — which is what a cinema with both regular seats and recliners would have seen on
      its readiness page, for a configuration that is entirely correct. Each ticket type is
      still priced against its OWN class below, which is where the ceilings are enforced.
    */
    const summaryClasses = seatCategories.length === 1 ? seatCategories : [];
    const resolution = await this.policies.resolveForCinema(
      cinema,
      'INR',
      summaryClasses,
      at,
      unmappedSeatCategories,
    );
    const policy = resolution.policy;

    /*
      Priced per ticket type against ITS OWN seat class, not against the cart's. A recliner
      ceiling must not be lent to a regular seat, and a regular ceiling must not condemn a
      recliner — which is exactly what happens if one resolution is reused for every row.
    */
    const prices = await Promise.all(
      ticketTypes.map(async (t) => {
        const own = t.seatCategory?.regulatoryClass
          ? await this.policies.resolveForCinema(
              cinema,
              'INR',
              [t.seatCategory.regulatoryClass],
              at,
            )
          : resolution;
        const check = checkTicketPrice(own, t.priceMinor);
        return {
          ticketTypeId: t.id,
          name: t.name,
          priceMinor: t.priceMinor,
          ok: check.ok,
          reason: check.reason,
        };
      }),
    );

    return {
      jurisdiction: {
        country: cinema.country ?? cinema.venue?.country ?? null,
        region: cinema.region ?? cinema.venue?.region ?? null,
        district: cinema.district,
        city: cinema.city ?? cinema.venue?.city ?? null,
        localBodyType: cinema.localBodyType,
      },
      classification: { cinemaFormat: cinema.cinemaFormat, climateType: cinema.climateType },
      status: resolution.status,
      summary: this.summarise(resolution.status, resolution.explanation, prices),
      regulatoryReference: policy?.regulatoryReference ?? null,
      effectiveFrom: policy?.effectiveFrom?.toISOString() ?? null,
      maintenance: policy?.maintenanceChargeMinor
        ? {
            perTicketMinor: policy.maintenanceChargeMinor,
            treatment: policy.maintenanceTreatment,
            description: MAINTENANCE_WORDS[policy.maintenanceTreatment] ?? 'Not applicable.',
          }
        : null,
      maxTicketPriceMinor: policy?.ticketPriceMaxMinor ?? null,
      ticketPriceRule: policy?.ticketPriceRule ?? null,
      onlineFee: {
        policy: policy?.onlineFeePolicy ?? 'ALLOWED',
        description: ONLINE_FEE_WORDS[policy?.onlineFeePolicy ?? 'ALLOWED'],
      },
      // Reported so the organizer is not surprised at publish time. The refusal itself lives
      // in the booking and publishing paths, where a client cannot skip it.
      blocksPublishing: BLOCKING.includes(resolution.status) || prices.some((p) => !p.ok),
      prices,
    };
  }

  /**
   * Every sellable seat category in this cinema, and what the operator has mapped it to.
   *
   * Listed as a whole rather than only the unmapped ones, because the question an exhibitor is
   * answering is "is this right?", not "what is missing?" — and a mapping that is present and
   * WRONG is the more expensive mistake. A "Gold" seat mapped to REGULAR when the operator
   * meant PREMIUM sells legally at the wrong ceiling, and nothing will ever complain.
   */
  async seatClassesFor(user: { id: string }, cinemaId: string) {
    const cinema = await this.prisma.cinema.findUnique({
      where: { id: cinemaId },
      select: { organizationId: true },
    });
    if (!cinema) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Cinema not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user as never, cinema.organizationId);

    const categories = await this.prisma.seatCategory.findMany({
      where: { seatMap: { screen: { cinemaId } } },
      select: { id: true, name: true, regulatoryClass: true, basePriceMinor: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return categories.map((c) => ({ ...c, mapped: c.regulatoryClass != null }));
  }

  /**
   * Record which regulatory class a seat category belongs to.
   *
   * Setting it to null is allowed and is not an oversight: an operator who realises they
   * mapped the wrong class must be able to withdraw the answer rather than leave a confident
   * wrong one in place. In a regulated jurisdiction that stops the seat selling until it is
   * mapped again, which is the correct consequence of not knowing.
   */
  async setSeatClass(
    user: { id: string },
    cinemaId: string,
    seatCategoryId: string,
    regulatoryClass: string | null,
  ) {
    const cinema = await this.prisma.cinema.findUnique({
      where: { id: cinemaId },
      select: { organizationId: true },
    });
    if (!cinema) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Cinema not found.', HttpStatus.NOT_FOUND);
    }
    await this.access.assertMember(user as never, cinema.organizationId);

    // Scoped through the cinema, so an id from another operator's seat map cannot be edited by
    // guessing it. The lookup is the authorisation, not a separate check that can drift.
    const category = await this.prisma.seatCategory.findFirst({
      where: { id: seatCategoryId, seatMap: { screen: { cinemaId } } },
      select: { id: true },
    });
    if (!category) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'That seat category does not belong to this cinema.',
        HttpStatus.NOT_FOUND,
      );
    }

    const updated = await this.prisma.seatCategory.update({
      where: { id: seatCategoryId },
      data: { regulatoryClass: regulatoryClass as never },
      select: { id: true, name: true, regulatoryClass: true },
    });

    // Worth an audit entry: this is the field that decides which ceiling a seat is sold under.
    await this.audit.record({
      organizationId: cinema.organizationId,
      actorUserId: user.id,
      action: 'SEAT_CATEGORY_REGULATORY_CLASS_SET',
      entityType: 'SeatCategory',
      entityId: seatCategoryId,
      metadata: { name: updated.name, regulatoryClass: updated.regulatoryClass },
    });
    return updated;
  }

  /** One sentence, in the exhibitor's terms rather than the enum's. */
  private summarise(
    status: PricingComplianceStatus,
    explanation: string,
    prices: { name: string; priceMinor: number; ok: boolean; reason: string | null }[],
  ): string {
    const over = prices.find((p) => !p.ok);
    if (over) {
      // The most actionable message this service produces, so it leads with the number and
      // names the ticket type rather than describing the concept.
      return `Cannot publish — ${over.name} is priced at ₹${(over.priceMinor / 100).toFixed(0)}. ${over.reason}`;
    }
    switch (status) {
      case 'NOT_REGULATED':
        return 'No cinema pricing order applies to this location. Standard platform pricing is in effect.';
      case 'COMPLIANT':
        return 'Compliant — ticket prices are within the permitted rates for this classification.';
      case 'REQUIRES_APPROVAL':
        return 'Compliance review required — the online booking fee for this jurisdiction is pending confirmation, so no booking fee is charged.';
      case 'INVALID_CINEMA_CLASSIFICATION':
        return 'Cannot publish — this jurisdiction prices by cinema classification and this cinema has not been classified. Set its local body, format and climate type.';
      case 'POLICY_NOT_FOUND':
        return `Cannot publish — no pricing order is configured for this location. ${explanation}`;
      case 'POLICY_CONFIGURATION_ERROR':
        return 'Cannot publish — the pricing configuration for this location needs attention from ETicketsGo.';
      default:
        return explanation;
    }
  }
}

const BLOCKING: PricingComplianceStatus[] = [
  'POLICY_NOT_FOUND',
  'PRICE_EXCEEDS_LIMIT',
  'INVALID_CINEMA_CLASSIFICATION',
  'POLICY_CONFIGURATION_ERROR',
];

const MAINTENANCE_WORDS: Record<string, string> = {
  INCLUDED_IN_TICKET_PRICE:
    'Included in the ticket price. It is shown to the customer but does not increase what they pay.',
  ADDED_TO_TICKET_PRICE: 'Added to the ticket price as a separate line at checkout.',
  UNCONFIRMED:
    'Recorded, but whether it is included in the price or added to it has not been confirmed. This policy cannot be used until it is.',
  NOT_APPLICABLE: 'Not applicable in this jurisdiction.',
};

const ONLINE_FEE_WORDS: Record<string, string> = {
  ALLOWED: 'A booking fee may be charged.',
  CAPPED: 'A booking fee may be charged up to the permitted maximum.',
  INCLUDED_IN_TICKET_PRICE:
    'The permitted rate already includes online booking charges, so no separate fee is charged.',
  PROHIBITED: 'No booking fee may be charged in this jurisdiction.',
  REQUIRES_APPROVAL:
    'Pending regulatory approval — no booking fee is charged until the position for this jurisdiction is confirmed.',
};
