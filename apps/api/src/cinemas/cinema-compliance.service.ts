import { HttpStatus, Injectable } from '@nestjs/common';
import { Role, currencyForCountry, type PricingComplianceStatus } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AuditService } from '../audit/audit.service';
import { AppException, ErrorCodes } from '../common/errors';
import { CinemaPricingPolicyService } from '../pricing/cinema-policy/cinema-pricing-policy.service';
import { applyPolicy, checkTicketPrice } from '../pricing/cinema-policy/apply-policy';
import {
  REGULATORY_CLASSES,
  ceilingFrom,
  type ClassCeiling,
} from '../pricing/cinema-policy/class-ceilings';
import { placePosition, unmappedSeatClassMessage } from '../pricing/cinema-policy/sale-eligibility';

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
  /**
   * WHY an INVALID_CINEMA_CLASSIFICATION status was given, in the sale-blocker codes the
   * readiness report already uses; null for every other status.
   *
   * The resolver gives that one status for two different jobs: a seat category with no
   * regulatory seat class (the organizer maps it under Seat classes) and a cinema with no
   * local body, format or climate type on record. The summary used to describe only the
   * second, so an exhibitor whose cinema WAS classified (QA Vijayawada, "Platinum Executive"
   * unmapped) was sent to fields that were already set. Wording only: `status` and
   * `blocksPublishing` are unchanged, and nothing here decides what sells.
   */
  reasonCode: 'SEAT_CLASS_UNMAPPED' | 'CINEMA_NOT_CLASSIFIED' | null;
  /** Display names of seat categories with no regulatory seat class, for the reason above. */
  unmappedSeatCategories: string[];
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
  onlineFee: {
    policy: string;
    description: string;
    /**
     * The most checkout will add as a booking fee, from the same function checkout uses.
     * `null` = the platform's ordinary fee schedule applies; `0` = checkout holds the fee at
     * zero (no rule resolved, or the rule forbids or has not confirmed one).
     */
    maxMinor: number | null;
  };
  /** Per ticket type, when prices were supplied. */
  prices: {
    ticketTypeId: string;
    name: string;
    priceMinor: number;
    ok: boolean;
    reason: string | null;
    /**
     * False when the only shows using this ticket type have finished. Such a price can no
     * longer be sold, so it is history: it must not lead the headline or block anything new.
     */
    upcoming: boolean;
  }[];
  /** Whether the server would currently refuse to sell. Reported, not enforced here. */
  blocksPublishing: boolean;
  /**
   * The limit for each regulatory seat class at this cinema, one class at a time - the way
   * checkout prices a ticket. Empty when no pricing order applies here at all.
   *
   * The whole-room answer above can only name an order when the room has ONE class: a
   * multiplex with regular seats and recliners resolves at the level of the state and states
   * no ceiling, so the panel read "Order: None applies" for a cinema the Andhra Pradesh order
   * plainly covers. These rows are what the exhibitor actually needs: Regular up to Rs 150,
   * Recliner up to Rs 250, Premium not sold here.
   */
  classRates: ClassCeiling[];
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
        eventSession: { select: { startsAt: true } },
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
    const classRates = await this.classRatesFor(cinema, at);

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
          upcoming: t.eventSession.startsAt.getTime() > at.getTime(),
        };
      }),
    );
    // Display only: what the headline may blame. A finished show's old price is history.
    const livePrices = prices.filter((p) => p.upcoming);
    /*
      The resolver checks unmapped seat categories BEFORE classification, so when it was given
      any and answered INVALID_CINEMA_CLASSIFICATION, they are the reason. Otherwise that
      status means the classification itself is missing.
    */
    const reasonCode: ComplianceView['reasonCode'] =
      resolution.status !== 'INVALID_CINEMA_CLASSIFICATION'
        ? null
        : unmappedSeatCategories.length > 0
          ? 'SEAT_CLASS_UNMAPPED'
          : 'CINEMA_NOT_CLASSIFIED';
    const classified = Boolean(cinema.localBodyType && cinema.cinemaFormat && cinema.climateType);
    /*
      The place on its own, with the unmapped categories set aside - only to word the summary
      truthfully (see `unmappedSeatClassMessage`): Telangana has no price rules at all, so
      "this location sets a price limit for each seat class" was false there.
    */
    const placeStatus =
      reasonCode === 'SEAT_CLASS_UNMAPPED'
        ? (await placePosition((cls) => this.policies.resolveForCinema(cinema, 'INR', cls, at, [])))
            .status
        : null;
    const placeName =
      cinema.region?.trim() ||
      cinema.venue?.region?.trim() ||
      cinema.city?.trim() ||
      cinema.venue?.city?.trim() ||
      'this area';

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
      reasonCode,
      unmappedSeatCategories: reasonCode === 'SEAT_CLASS_UNMAPPED' ? unmappedSeatCategories : [],
      summary: this.summarise(resolution.status, resolution.explanation, livePrices, {
        reasonCode,
        unmappedSeatCategories,
        placeStatus,
        placeName,
        /*
          Only where the state's order actually prices by it: a Telangana cinema (no rules at
          all) was told it "also needs its local body, format and climate type", which would
          change nothing there.
        */
        classified:
          classified || !classRates.some((r) => r.status === 'INVALID_CINEMA_CLASSIFICATION'),
      }),
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
      onlineFee: this.onlineFeeView(resolution),
      // Reported so the organizer is not surprised at publish time. The refusal itself lives
      // in the booking and publishing paths, where a client cannot skip it.
      blocksPublishing: BLOCKING.includes(resolution.status) || prices.some((p) => !p.ok),
      prices,
      classRates,
    };
  }

  /**
   * Each class's limit here. Read only: the resolver checkout uses, asked once per class.
   * Empty when every class answers NOT_REGULATED, so an unregulated cinema shows no table.
   */
  private async classRatesFor(
    cinema: Parameters<CinemaPricingPolicyService['resolveForCinema']>[0],
    at: Date,
  ): Promise<ClassCeiling[]> {
    const rows: ClassCeiling[] = [];
    for (const cls of REGULATORY_CLASSES) {
      rows.push(ceilingFrom(cls, await this.policies.resolveForCinema(cinema, 'INR', [cls], at)));
    }
    return rows.some((r) => r.regulated) ? rows : [];
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
      include: { venue: { select: { country: true, region: true, city: true } } },
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
    /*
      The currency these prices are in. A seat category stores an amount and no currency, and
      the screen printed every one in rupees - including a cinema in Boise. Currency follows
      the venue, by the same rule a ticket priced from this category will use. Null when the
      country is not one we sell in, and the screen then shows no price rather than a wrong one.
    */
    const currency = currencyForCountry(cinema.country ?? cinema.venue?.country);
    /*
      Which classes this cinema's order actually prices. A class with no rate row resolves to
      no policy, so choosing it leaves the seat with nothing to be priced against. Read only:
      the same resolver as above, asked once per class, changing nothing.
    */
    const coverage: Record<string, boolean> = {};
    /*
      And what each class allows, so the choice is made knowing the answer: "Regular, up to
      Rs 150" next to a Rs 200 category says which class it cannot be, before anyone picks it.
    */
    let classRates: ClassCeiling[] = [];
    if (categories.length > 0) {
      const now = new Date();
      for (const cls of REGULATORY_CLASSES) {
        const r = await this.policies.resolveForCinema(cinema, 'INR', [cls], now);
        coverage[cls] = r.status === 'NOT_REGULATED' || r.policy != null;
        classRates.push(ceilingFrom(cls, r));
      }
      if (!classRates.some((r) => r.regulated)) classRates = [];
    }
    return categories.map((c) => ({
      ...c,
      currency,
      mapped: c.regulatoryClass != null,
      classHasRate: coverage,
      classRates,
    }));
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
    /*
      Owners and managers only. This is the field that decides which legal price ceiling a seat
      sells under, and membership alone let check-in staff rewrite it — moving a recliner onto
      the regular rate, or clearing a mapping so the seat stops selling. Reading the mapping
      stays open to every member; changing it is a pricing decision.
    */
    await this.access.assertMember(user as never, cinema.organizationId, [
      Role.ORGANIZER_OWNER,
      Role.ORGANIZER_MANAGER,
    ]);

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

  /**
   * What checkout does about the booking fee here, not what a missing policy would imply.
   *
   * With no policy row this used to say ALLOWED ("a fee may be charged") while checkout held
   * the fee at zero. The amount comes from `applyPolicy`, the function checkout uses.
   */
  private onlineFeeView(resolution: Parameters<typeof applyPolicy>[0]) {
    const maxMinor = applyPolicy(resolution, 1).maxOnlineFeeMinor;
    const policy = resolution.policy?.onlineFeePolicy;
    if (!policy && resolution.status !== 'NOT_REGULATED') {
      return {
        policy: 'UNRESOLVED',
        description:
          'No pricing rule applies yet, so checkout holds the booking fee at 0 until the rule is configured.',
        maxMinor,
      };
    }
    return {
      policy: policy ?? 'ALLOWED',
      description: ONLINE_FEE_WORDS[policy ?? 'ALLOWED'],
      maxMinor,
    };
  }

  /** One sentence, in the exhibitor's terms rather than the enum's. */
  private summarise(
    status: PricingComplianceStatus,
    explanation: string,
    prices: { name: string; priceMinor: number; ok: boolean; reason: string | null }[],
    why: {
      reasonCode: ComplianceView['reasonCode'];
      unmappedSeatCategories: string[];
      placeStatus: PricingComplianceStatus | null;
      placeName: string;
      classified: boolean;
    },
  ): string {
    const over = prices.find((p) => !p.ok);
    if (over) {
      // The most actionable message this service produces, so it leads with the number and
      // names the ticket type rather than describing the concept.
      return `${over.name} tickets cannot be sold at ₹${(over.priceMinor / 100).toFixed(0)}. ${over.reason}`;
    }
    switch (status) {
      case 'NOT_REGULATED':
        return 'No cinema pricing order applies to this location. Standard platform pricing is in effect.';
      case 'COMPLIANT':
        return 'Compliant — ticket prices are within the permitted rates for this classification.';
      case 'REQUIRES_APPROVAL':
        return 'Compliance review required — the online booking fee for this jurisdiction is pending confirmation, so no booking fee is charged.';
      case 'INVALID_CINEMA_CLASSIFICATION':
        if (why.reasonCode === 'SEAT_CLASS_UNMAPPED') {
          // Named, because the fix is one field on one seat category. Says so too when the
          // place ALSO blocks (no rules, or no legal type on record), so the next wall is not a
          // surprise. The same sentence readiness and the event page use.
          return unmappedSeatClassMessage(
            why.unmappedSeatCategories,
            why.placeName,
            why.placeStatus,
          );
        }
        return (
          "Tickets cannot be sold yet: this location sets prices by the cinema's legal type " +
          '(local body, format and cooling), and this cinema has none on record. Only ETicketsGo ' +
          'can set it: use "Ask ETicketsGo to change this" below.'
        );
      case 'POLICY_NOT_FOUND':
        return `Tickets cannot be sold yet: no pricing order is configured for this location. ${explanation}`;
      case 'POLICY_CONFIGURATION_ERROR':
        return 'Tickets cannot be sold yet: the pricing configuration for this location needs attention from ETicketsGo.';
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
