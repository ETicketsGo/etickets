import { blocksBooking, currencyForCountry, money } from '@eticketsgo/shared-types';
import type {
  CinemaFormat,
  ClimateType,
  LocalBodyType,
  PricingComplianceStatus,
} from '@eticketsgo/shared-types';
import type { PolicyContext, PolicyResolution } from './cinema-pricing-policy.resolver';
import { applyPolicy, checkTicketPrice, type PolicyEffect } from './apply-policy';

/**
 * Can this be sold online? One answer, for checkout, for the organizer and for the storefront.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────
 * Found on QA (2026-10-09, cinema journey). The cinema readiness page said "Ready to open,
 * Blocking 0" while every checkout for that cinema's shows was refused with a 409: "This
 * showing cannot be sold online yet: its regulatory pricing is not configured. India has
 * active cinema pricing policies but none covers Telangana". The buyer saw a toast that
 * vanished, and seats stayed selectable for a show nobody could buy.
 *
 * Three readers, three answers. Checkout asked the pricing policy engine. Readiness never
 * asked it at all. The storefront could not ask anybody. Each was internally consistent and
 * together they told the organizer "ready" and the buyer "try again".
 *
 * So the decision now lives here, once:
 *
 *   - `resolveCinemaPolicy` is the regulatory lookup checkout has always made, moved here
 *     unchanged so it can be called by somebody other than checkout.
 *   - `saleBlockersFromPolicy` turns that lookup into the refusals checkout makes. Checkout
 *     refuses exactly when it returns a blocker, and for no other regulatory reason.
 *   - `sessionSaleEligibility` asks the same two questions for every cart a buyer could build
 *     for one show, so readiness and the storefront hear about a refusal BEFORE a buyer meets
 *     it - from the same code that will make it.
 *
 * ── WHAT IS NOT HERE ──────────────────────────────────────────────────────────────
 * No rate, no state name, no price. Those are rows the policy engine reads. Nothing here
 * changes what a ticket costs, what tax it carries, or how many seats exist: `effect` is
 * passed through untouched for the pricing service, exactly as before.
 */

/** Where a cinema is and how it is classified. Everything a pricing policy matches on. */
export interface PolicyCinema {
  id?: string | null;
  country: string | null;
  region: string | null;
  district: string | null;
  city: string | null;
  localBodyType: LocalBodyType | null;
  cinemaFormat: CinemaFormat | null;
  climateType: ClimateType | null;
  venue?: { country: string | null; region: string | null; city: string | null } | null;
}

/** One kind of ticket in a cart, as the policy engine needs to see it. */
export interface AdmissionLine {
  unitPriceMinor: number;
  quantity: number;
  /** The mapped regulatory class, or null when the operator has not mapped this category. */
  category?: string | null;
  /** What the operator calls the seat category - for messages, never for matching. */
  seatCategoryName?: string | null;
  ticketTypeId?: string;
  ticketTypeName?: string | null;
}

/** A line priced above (or below) what its own seat class permits. */
export interface OverCeilingLine {
  seatCategoryName: string | null;
  priceMinor: number;
  reason: string;
  ticketTypeId?: string;
  ticketTypeName?: string | null;
  /** The permitted maximum for this line's class, when the policy states one. */
  maxMinor: number | null;
  /** The permitted minimum for this line's class, when the policy states one. */
  minMinor: number | null;
}

export interface CinemaPolicyOutcome {
  resolution: PolicyResolution;
  effect: PolicyEffect;
  context: PolicyContext;
  /** Lines whose price breaks the band for THEIR OWN seat class. Empty when compliant. */
  overCeiling: OverCeilingLine[];
}

/** How a policy is looked up. The service's `resolve`, or a memo around it. */
export type ResolvePolicy = (ctx: PolicyContext) => Promise<PolicyResolution>;

export type SaleBlockerCode =
  /** No policy covers this state. Only the platform can write one. */
  | 'NO_PRICING_POLICY'
  /** Two equally specific policies match. Only the platform can resolve it. */
  | 'PRICING_POLICY_CONFLICT'
  /** The state prices by type of cinema and this cinema has no type recorded. */
  | 'CINEMA_NOT_CLASSIFIED'
  /** A seat category in a regulated state with no regulatory class. The organizer maps it. */
  | 'SEAT_CLASS_UNMAPPED'
  /** A ticket priced outside the band its seat class permits. The organizer re-prices it. */
  | 'PRICE_OVER_CEILING'
  /** Anything else the engine refuses. Treated as the platform's, because we do not know. */
  | 'REGULATORY_PRICING_UNRESOLVED';

export interface SaleBlocker {
  code: SaleBlockerCode;
  /** Who can put it right. A PLATFORM blocker never carries a fix path. */
  owner: 'ORGANIZER' | 'PLATFORM';
  /** What is wrong and what to do, in the organizer's words. Never a status name or a G.O. */
  organizerMessage: string;
  /** Where the organizer fixes it, relative to the organizer console. Null when nowhere. */
  fixPath: string | null;
  /** What a buyer may be told. Deliberately the same sentence for every blocker. */
  buyerMessage: string;
  /** The seat category or ticket type it is about, when it is about one. */
  subject?: string;
  /** Ticket types this stops. Every ticket type of the show when it stops the whole show. */
  ticketTypeIds: string[];
}

export interface SaleEligibility {
  /** False when at least one blocker exists. */
  sellable: boolean;
  blockers: SaleBlocker[];
}

export interface SessionSaleEligibility extends SaleEligibility {
  /**
   * Ticket types a buyer can actually complete a purchase for.
   *
   * Separate from `sellable` because one unmapped seat category does not stop the rest of the
   * room selling - checkout prices each cart on its own - and the storefront must not close a
   * show that would sell. Empty means nothing on the show can be bought.
   */
  sellableTicketTypeIds: string[];
}

/**
 * The one sentence a buyer is shown when a show cannot be sold.
 *
 * Never the reason. A buyer cannot act on "Telangana has no rate order", and naming the
 * regulation to somebody who came to see a film is the sentence about our configuration this
 * whole change exists to stop showing them. The storefront translates it by code; this
 * English is what any other client (and the 409 itself) carries.
 */
export const BUYER_SALE_NOT_OPEN =
  'Online booking is not open for this show yet. Please check back later or contact the venue.';

/** The reason the API attaches to a refusal, so a client can tell it from a lost seat. */
export const SALE_NOT_OPEN_REASON = 'SALE_NOT_OPEN';

const isRegulatedStatus = (status: PricingComplianceStatus): boolean => status !== 'NOT_REGULATED';

/**
 * Resolve the cinema pricing policy for one cart, once.
 *
 * Moved here from `BookingsService` without a change to its logic, so that the organizer's
 * readiness page and the storefront can ask the question checkout asks rather than a copy of
 * it. The comments are the ones it carried there.
 *
 * ── WHY A SESSION WITHOUT A CINEMA IS NOT AN ERROR ────────────────────────────────
 * It is every concert, every conference and every general-admission event on the platform.
 * They resolve NOT_REGULATED, which leaves fees, tax and totals exactly as they were before
 * this subsystem existed.
 */
export async function resolveCinemaPolicy(
  resolve: ResolvePolicy | null | undefined,
  cinema: PolicyCinema | null | undefined,
  currency: string,
  admissionLines: AdmissionLine[],
  at: Date,
): Promise<CinemaPolicyOutcome> {
  // Seat classes in the cart, so a rule written for one class can match. De-duplicated
  // because the rule asks "is this class present", not "how many".
  const seatCategories = [
    ...new Set(admissionLines.map((l) => l.category).filter((c): c is string => Boolean(c))),
  ];
  /*
    Seat categories in this cart that the operator has NOT mapped to a regulatory class.

    Reported separately rather than just being absent from `seatCategories`, because absent
    is indistinguishable from "this cart has no seat classes" - which matches the
    class-agnostic fallback row and sells the seat with no ceiling at all. Only admission
    lines that actually have a seat category count: a ticket type with none attached is not
    an unmapped seat, it is a ticket that is not seated.
  */
  const unmappedSeatCategories = [
    ...new Set(
      admissionLines
        .filter((l) => !l.category && l.seatCategoryName)
        .map((l) => l.seatCategoryName as string),
    ),
  ];
  /*
    ── WHY A MULTI-CLASS CART RESOLVES WITHOUT A SEAT CLASS ──────────────────────────
    A cart holding one regular seat and one recliner matches the regular row AND the
    recliner row, and they are equally specific - so the resolver would report "2 equally
    specific policies match this order" and refuse a sale that is entirely legal. What the
    CART needs from a policy is the jurisdiction-level position; the per-seat ceilings are
    resolved separately below, one class at a time. Nothing is loosened.
  */
  const cartClasses = seatCategories.length === 1 ? seatCategories : [];

  const context: PolicyContext = {
    country: cinema?.country ?? cinema?.venue?.country ?? null,
    region: cinema?.region ?? cinema?.venue?.region ?? null,
    district: cinema?.district ?? null,
    city: cinema?.city ?? cinema?.venue?.city ?? null,
    currency,
    localBodyType: cinema?.localBodyType ?? null,
    cinemaFormat: cinema?.cinemaFormat ?? null,
    climateType: cinema?.climateType ?? null,
    seatCategories: cartClasses,
    unmappedSeatCategories,
    at,
  };
  /*
    No policy service wired - a unit harness. Report NOT_REGULATED explicitly rather than
    pretending a lookup happened: the caller then takes exactly the same path as any
    unregulated market, and nothing silently claims compliance it never checked.
  */
  const resolution: PolicyResolution = resolve
    ? await resolve(context)
    : {
        status: 'NOT_REGULATED',
        policy: null,
        explanation: 'Cinema pricing policy resolution is not configured in this context.',
        specificity: -1,
      };
  // Tickets, not lines: a maintenance charge is per head.
  const ticketCount = admissionLines.reduce((n, l) => n + Math.max(0, l.quantity), 0);

  /*
    Each line is checked against the ceiling for ITS OWN seat class, which needs a
    resolution per class rather than the one cart-wide resolution above. Reusing a single
    resolution would lend a recliner's ceiling to a regular seat, and the reverse.
  */
  const overCeiling: OverCeilingLine[] = [];
  if (resolve && isRegulatedStatus(resolution.status)) {
    for (const cls of seatCategories) {
      const perClass = await resolve({ ...context, seatCategories: [cls] });
      for (const line of admissionLines.filter((l) => l.category === cls)) {
        const verdict = checkTicketPrice(perClass, line.unitPriceMinor);
        if (!verdict.ok) {
          overCeiling.push({
            seatCategoryName: line.seatCategoryName ?? cls,
            priceMinor: line.unitPriceMinor,
            reason: verdict.reason ?? 'Above the permitted rate for this seat class.',
            ticketTypeId: line.ticketTypeId,
            ticketTypeName: line.ticketTypeName ?? null,
            maxMinor: perClass.policy?.ticketPriceMaxMinor ?? null,
            minMinor: perClass.policy?.ticketPriceMinMinor ?? null,
          });
        }
      }
    }
  }

  return { resolution, effect: applyPolicy(resolution, ticketCount), context, overCeiling };
}

/** The cinema's readiness page, where the seat-class control lives. */
const seatClassesPath = (cinemaId?: string | null) =>
  cinemaId ? `/organizer/cinemas/${cinemaId}/readiness#seat-classes` : '/organizer/cinemas';
const schedulePath = (cinemaId?: string | null) =>
  cinemaId ? `/organizer/cinemas/${cinemaId}/schedule` : '/organizer/cinemas';

/** "Telangana", else the city, else a phrase that is still a sentence. */
function placeName(ctx: PolicyContext): string {
  return ctx.region?.trim() || ctx.city?.trim() || 'this area';
}

const listOf = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * The refusals checkout makes for one cart, as blockers.
 *
 * ── CHECKOUT REFUSES EXACTLY WHEN THIS RETURNS SOMETHING ──────────────────────────
 * The order is checkout's order, and it matters: an unresolved policy has no ceilings to read,
 * so it is reported alone; only a resolved one is then checked line by line against its
 * bands. That is the two `if`s checkout always had, and nothing else.
 *
 * ── THE ORGANIZER IS TOLD WHAT TO DO, NOT WHAT THE ENGINE SAID ────────────────────
 * The resolver's explanation names policy references and status names. That is right for an
 * audit entry and useless to a cinema manager, so it goes to the audit and these sentences go
 * to the person. A blocker only the platform can clear says so, and carries no link: sending
 * somebody to look for a control that does not exist wastes the afternoon they have.
 */
export function saleBlockersFromPolicy(
  outcome: CinemaPolicyOutcome,
  where: { cinemaId?: string | null; ticketTypeIds: string[] },
): SaleBlocker[] {
  const { resolution, context } = outcome;
  const place = placeName(context);
  const base = { buyerMessage: BUYER_SALE_NOT_OPEN, ticketTypeIds: where.ticketTypeIds };

  if (blocksBooking(resolution.status)) {
    const unmapped = (context.unmappedSeatCategories ?? []).filter((n) => n.trim());
    if (resolution.status === 'INVALID_CINEMA_CLASSIFICATION' && unmapped.length > 0) {
      return [
        {
          ...base,
          code: 'SEAT_CLASS_UNMAPPED',
          owner: 'ORGANIZER',
          organizerMessage:
            `Seat ${unmapped.length === 1 ? 'category' : 'categories'} ${listOf(unmapped)} ` +
            `${unmapped.length === 1 ? 'needs' : 'need'} a regulatory seat class before ` +
            `tickets can be sold. ${place} caps the price of each class. Set it under Seat classes.`,
          fixPath: seatClassesPath(where.cinemaId),
          subject: unmapped.join(', '),
        },
      ];
    }
    if (resolution.status === 'INVALID_CINEMA_CLASSIFICATION') {
      return [
        {
          ...base,
          code: 'CINEMA_NOT_CLASSIFIED',
          owner: 'PLATFORM',
          organizerMessage:
            `Ticket sales are paused for this cinema: ${place} sets ticket prices by type of ` +
            'cinema, and this cinema has no type on record yet. Contact support to set it.',
          fixPath: null,
        },
      ];
    }
    if (resolution.status === 'POLICY_NOT_FOUND') {
      return [
        {
          ...base,
          code: 'NO_PRICING_POLICY',
          owner: 'PLATFORM',
          organizerMessage:
            `Ticket sales are paused for cinemas in ${place}: no state price rules are ` +
            'configured yet. Contact support.',
          fixPath: null,
        },
      ];
    }
    if (resolution.status === 'POLICY_CONFIGURATION_ERROR') {
      return [
        {
          ...base,
          code: 'PRICING_POLICY_CONFLICT',
          owner: 'PLATFORM',
          organizerMessage:
            `Ticket sales are paused for cinemas in ${place}: the platform's price rules for ` +
            'this area need correcting. Contact support.',
          fixPath: null,
        },
      ];
    }
    return [
      {
        ...base,
        code: 'REGULATORY_PRICING_UNRESOLVED',
        owner: 'PLATFORM',
        organizerMessage:
          `Ticket sales are paused for cinemas in ${place}: the state price rules cannot be ` +
          'applied yet. Contact support.',
        fixPath: null,
      },
    ];
  }

  return outcome.overCeiling.map((line) => {
    const name = line.ticketTypeName ?? line.seatCategoryName ?? 'A ticket';
    const price = money(line.priceMinor, context.currency);
    const limit =
      line.maxMinor != null && line.priceMinor > line.maxMinor
        ? `above the most ${place} allows for its seat class (${money(line.maxMinor, context.currency)})`
        : line.minMinor != null && line.priceMinor < line.minMinor
          ? `below the least ${place} allows for its seat class (${money(line.minMinor, context.currency)})`
          : `outside what ${place} allows for its seat class`;
    return {
      ...base,
      ...(line.ticketTypeId ? { ticketTypeIds: [line.ticketTypeId] } : {}),
      code: 'PRICE_OVER_CEILING' as const,
      owner: 'ORGANIZER' as const,
      organizerMessage:
        `${name} is priced at ${price}, ${limit}. Change the price on the schedule, ` +
        'or check its seat class under Seat classes.',
      fixPath: schedulePath(where.cinemaId),
      subject: name,
    };
  });
}

/** One cart's answer. What checkout uses. */
export async function cartSaleEligibility(
  resolve: ResolvePolicy | null | undefined,
  cinema: PolicyCinema | null | undefined,
  currency: string,
  lines: AdmissionLine[],
  at: Date,
): Promise<{ eligibility: SaleEligibility; policy: CinemaPolicyOutcome }> {
  const policy = await resolveCinemaPolicy(resolve, cinema, currency, lines, at);
  const blockers = saleBlockersFromPolicy(policy, {
    cinemaId: cinema?.id ?? null,
    ticketTypeIds: lines.map((l) => l.ticketTypeId).filter((id): id is string => Boolean(id)),
  });
  return { eligibility: { sellable: blockers.length === 0, blockers }, policy };
}

/** A show's ticket type, as much of it as eligibility needs. */
export interface EligibilityTicketType {
  id: string;
  name: string;
  priceMinor: number;
  currency: string | null;
  seatCategory: { name: string; regulatoryClass: string | null } | null;
}

/** A ticket type as one line of one, which is how checkout would see it in a cart. */
const lineOf = (t: EligibilityTicketType): AdmissionLine => ({
  unitPriceMinor: t.priceMinor,
  quantity: 1,
  category: t.seatCategory?.regulatoryClass ?? null,
  seatCategoryName: t.seatCategory?.name ?? null,
  ticketTypeId: t.id,
  ticketTypeName: t.name,
});

/**
 * Every cart a buyer could build for one show, asked of checkout's own rules.
 *
 * ── WHICH CARTS ───────────────────────────────────────────────────────────────────
 * Checkout prices one cart at a time, and two kinds of cart can be refused for different
 * reasons: a cart of one seat category resolves against that class's own row, and a cart of
 * several resolves at the level of the whole jurisdiction. So both are asked - each ticket
 * type on its own, and all of them together - and every refusal any of them would meet is
 * reported. A cart of some-but-not-all categories meets nothing those two do not.
 *
 * ── WHAT `at` MEANS ───────────────────────────────────────────────────────────────
 * Checkout resolves the policy at the moment of the sale, not at the show's date, so a
 * readiness check made now answers "would a purchase made now be refused". That is the
 * question the organizer is asking.
 */
export async function sessionSaleEligibility(
  resolve: ResolvePolicy | null | undefined,
  cinema: PolicyCinema | null | undefined,
  ticketTypes: EligibilityTicketType[],
  venueCountry: string | null | undefined,
  at: Date,
): Promise<SessionSaleEligibility> {
  const allIds = ticketTypes.map((t) => t.id);
  // A show with no cinema is not regulated, and checkout asks it nothing. Neither do we.
  if (!cinema || !resolve || ticketTypes.length === 0) {
    return { sellable: true, blockers: [], sellableTicketTypeIds: allIds };
  }
  const currencyOf = (t: EligibilityTicketType) =>
    t.currency?.trim().toUpperCase() || currencyForCountry(venueCountry) || null;

  const found: SaleBlocker[] = [];
  for (const t of ticketTypes) {
    const currency = currencyOf(t);
    // Checkout refuses a cart whose currency cannot be told, before pricing. Not ours to say.
    if (!currency) continue;
    const { eligibility } = await cartSaleEligibility(resolve, cinema, currency, [lineOf(t)], at);
    found.push(...eligibility.blockers);
  }
  const currencies = [...new Set(ticketTypes.map(currencyOf))];
  if (ticketTypes.length > 1 && currencies.length === 1 && currencies[0]) {
    const { eligibility } = await cartSaleEligibility(
      resolve,
      cinema,
      currencies[0],
      ticketTypes.map(lineOf),
      at,
    );
    /*
      A refusal of the whole cart that the single carts already met is the same fault seen
      again: "Standard is unmapped" stops the Standard seats, not the Gold ones beside them,
      and blaming every ticket type for it would close a room whose other seats sell. Only a
      KIND of refusal no single cart met is new - one that only a mixed cart meets - and that
      one is charged to every ticket type, because every ticket type is in that cart.
    */
    const seen = new Set(found.map((b) => b.code));
    found.push(...eligibility.blockers.filter((b) => !seen.has(b.code)));
  }

  // The same fault met by several carts is one fault: fold it, keeping every ticket it stops.
  const byKey = new Map<string, SaleBlocker>();
  for (const b of found) {
    const key = [b.code, b.subject ?? '', b.organizerMessage].join('|');
    const seen = byKey.get(key);
    if (seen) {
      seen.ticketTypeIds = [...new Set([...seen.ticketTypeIds, ...b.ticketTypeIds])];
    } else {
      byKey.set(key, { ...b, ticketTypeIds: [...b.ticketTypeIds] });
    }
  }
  const blockers = [...byKey.values()];
  const stopped = new Set(blockers.flatMap((b) => b.ticketTypeIds));
  return {
    sellable: blockers.length === 0,
    blockers,
    sellableTicketTypeIds: allIds.filter((id) => !stopped.has(id)),
  };
}

/**
 * A resolver that asks the database once per distinct question.
 *
 * A cinema with a hundred and forty shows asks the same handful of questions a hundred and
 * forty times - same place, same classes, same instant. Remembered for ONE evaluation only:
 * a policy written a minute later must be seen by the next readiness check and every sale.
 */
export function memoizedResolver(resolve: ResolvePolicy): ResolvePolicy {
  const seen = new Map<string, Promise<PolicyResolution>>();
  return (ctx) => {
    const key = JSON.stringify({ ...ctx, at: ctx.at.toISOString() });
    let hit = seen.get(key);
    if (!hit) {
      hit = resolve(ctx);
      seen.set(key, hit);
    }
    return hit;
  };
}
