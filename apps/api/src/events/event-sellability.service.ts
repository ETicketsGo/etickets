import { Injectable, Optional } from '@nestjs/common';
import { blocksBooking } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { currencyForCountry } from '../common/country';
import { CinemaPricingPolicyService } from '../pricing/cinema-policy/cinema-pricing-policy.service';
import { checkTicketPrice } from '../pricing/cinema-policy/apply-policy';

/**
 * Could somebody actually buy a ticket for this, right now?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Every refusal it reports was already implemented — at CHECKOUT, where the person who
 * meets it is a customer with a card in their hand. An organizer whose seat categories are
 * not mapped to a regulatory class finds out when a stranger fails to buy from them, and the
 * stranger finds out by being told "this showing cannot be sold online yet", which is a
 * sentence about our configuration presented to somebody who came here to see a film.
 *
 * That is the wrong end of the process to learn it at, for both of them. The facts are all
 * knowable the moment the event is configured: the ceiling, the seat classes, the prices and
 * the currency are all sitting in the database before anybody visits the page.
 *
 * ── WHY IT MIRRORS THE CHECKOUT RATHER THAN REPLACING IT ───────────────────────────
 * The booking path keeps every one of its refusals. This is a second reading of the same
 * rules, run earlier and addressed to a different person — exactly the relationship the
 * cinema compliance screen already has with the ticket-price ceiling.
 *
 * The alternative — making this the thing that decides, and letting checkout trust it —
 * would mean an event that passed the check at publish time could be edited into an illegal
 * one and keep selling. Configuration changes; a sale is checked when it happens.
 *
 * ── BLOCKERS AND WARNINGS ARE DIFFERENT ANSWERS ────────────────────────────────────
 * A blocker is a sale that WILL be refused. A warning is a sale that will succeed and is
 * probably not what the organizer meant — a dollar price on an Indian venue takes money
 * successfully, which is precisely why nothing else catches it.
 *
 * Refusing to publish over a warning would make the organizer's only route past it a support
 * ticket. Staying silent about it means the first person to notice is an accountant.
 */

export type SellabilityCode =
  | 'NO_SESSIONS'
  | 'NO_TICKET_TYPES'
  | 'REGULATORY_PRICING_UNRESOLVED'
  | 'SEAT_CLASS_UNMAPPED'
  | 'PRICE_OVER_CEILING'
  | 'FREE_EVENT_HAS_PRICES'
  | 'SEATED_SESSION_HAS_NO_SEATS'
  | 'CURRENCY_DISAGREES_WITH_VENUE';

export interface SellabilityIssue {
  code: SellabilityCode;
  /** What is wrong, in the organizer's vocabulary. Never an internal status name. */
  message: string;
  /** What to do about it. A problem statement without one is a complaint. */
  fix: string;
  /** Where to go, relative to the organizer console. Null when there is no single screen. */
  fixPath: string | null;
  eventSessionId?: string;
  /** Named so the organizer knows WHICH category or ticket type, not merely that one is bad. */
  subject?: string;
}

export interface SellabilityReport {
  eventId: string;
  /** False when at least one blocker exists. A warning never makes this false. */
  sellable: boolean;
  blockers: SellabilityIssue[];
  warnings: SellabilityIssue[];
  checkedAt: string;
}

@Injectable()
export class EventSellabilityService {
  constructor(
    private readonly prisma: PrismaService,
    /*
      Optional for the same reason the booking path takes it optionally: a deployment with no
      regulated market configured has no policy engine wired, and every check below that
      depends on one is simply skipped rather than reporting a false blocker.
    */
    @Optional() private readonly policies?: CinemaPricingPolicyService,
  ) {}

  async check(eventId: string, at: Date = new Date()): Promise<SellabilityReport> {
    const blockers: SellabilityIssue[] = [];
    const warnings: SellabilityIssue[] = [];

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        isFree: true,
        venue: { select: { country: true } },
        sessions: {
          select: {
            id: true,
            startsAt: true,
            seatMapId: true,
            screen: {
              select: {
                cinema: {
                  select: {
                    country: true,
                    region: true,
                    district: true,
                    city: true,
                    localBodyType: true,
                    cinemaFormat: true,
                    climateType: true,
                    venue: { select: { country: true, region: true, city: true } },
                  },
                },
              },
            },
            ticketTypes: {
              select: {
                id: true,
                name: true,
                priceMinor: true,
                currency: true,
                seatCategory: { select: { name: true, regulatoryClass: true } },
              },
            },
            _count: { select: { showSeats: true } },
          },
        },
      },
    });

    if (!event) {
      return { eventId, sellable: false, blockers, warnings, checkedAt: at.toISOString() };
    }

    if (event.sessions.length === 0) {
      blockers.push({
        code: 'NO_SESSIONS',
        message: 'This event has no dates, so there is nothing to sell.',
        fix: 'Add at least one show date.',
        fixPath: `/organizer/events/${eventId}/sessions`,
      });
    }

    for (const session of event.sessions) {
      const when = session.startsAt.toISOString();

      if (session.ticketTypes.length === 0) {
        blockers.push({
          code: 'NO_TICKET_TYPES',
          message: `The show on ${when} has no ticket types, so nobody can buy anything for it.`,
          fix: 'Add at least one ticket type to this show.',
          fixPath: `/organizer/events/${eventId}/sessions`,
          eventSessionId: session.id,
        });
        continue;
      }

      /*
        A room with a seat map but no seats laid down. The storefront renders an empty map
        and every seat click does nothing, which reads as a broken page rather than as an
        unfinished one.
      */
      if (session.seatMapId && session._count.showSeats === 0) {
        blockers.push({
          code: 'SEATED_SESSION_HAS_NO_SEATS',
          message: `The show on ${when} uses a seat map but has no seats on sale.`,
          fix: 'Re-assign the room to this show, or publish a layout that has seats in it.',
          fixPath: `/organizer/events/${eventId}/sessions`,
          eventSessionId: session.id,
        });
      }

      /*
        A free event whose tickets carry a price. Checkout refuses this outright, and the
        organizer's two possible intentions — a free event, or priced tickets — are both
        one edit away, so the message names both rather than picking one.
      */
      if (event.isFree) {
        const priced = session.ticketTypes.filter((t) => t.priceMinor > 0);
        if (priced.length > 0) {
          blockers.push({
            code: 'FREE_EVENT_HAS_PRICES',
            message:
              `The show on ${when} is part of a free event, but ` +
              `${priced.map((t) => t.name).join(', ')} still carries a price.`,
            fix: 'Set every ticket type to zero, or turn off the free-event setting.',
            fixPath: `/organizer/events/${eventId}`,
            eventSessionId: session.id,
            subject: priced.map((t) => t.name).join(', '),
          });
        }
      }

      /*
        The currency the tickets are priced in against the currency the venue's country
        sells in. A warning, not a blocker: the sale succeeds. It succeeds at the wrong
        price, in a currency the buyer's card will be charged in and the organizer will not
        be paid in, and nothing else on the platform will ever mention it.
      */
      const venueCurrency = currencyForCountry(event.venue?.country);
      if (venueCurrency) {
        const mismatched = [
          ...new Set(
            session.ticketTypes
              .filter((t) => t.currency && t.currency !== venueCurrency)
              .map((t) => t.currency),
          ),
        ];
        if (mismatched.length > 0) {
          warnings.push({
            code: 'CURRENCY_DISAGREES_WITH_VENUE',
            message:
              `The show on ${when} is priced in ${mismatched.join(', ')}, but its venue is in ` +
              `a country that sells in ${venueCurrency}.`,
            fix:
              `Re-price the ticket types in ${venueCurrency}, or correct the venue's country ` +
              `if the venue is not where it says it is.`,
            fixPath: `/organizer/events/${eventId}/sessions`,
            eventSessionId: session.id,
            subject: mismatched.join(', '),
          });
        }
      }

      // ── Regulated pricing. Only cinema sessions have any of this. ──
      const cinema = session.screen?.cinema;
      if (!cinema || !this.policies) continue;

      /*
        Named categories with no regulatory class. This is the exact configuration that
        produces "Seat category PR has no regulatory seat class" at checkout — reported here
        against the CATEGORY so the organizer knows which row to edit, rather than against
        the sale that failed.
      */
      const unmapped = [
        ...new Set(
          session.ticketTypes
            .filter((t) => t.seatCategory && !t.seatCategory.regulatoryClass)
            .map((t) => t.seatCategory!.name),
        ),
      ];

      const currency = session.ticketTypes[0]?.currency ?? venueCurrency ?? 'INR';
      const classes = [
        ...new Set(
          session.ticketTypes
            .map((t) => t.seatCategory?.regulatoryClass)
            .filter((c): c is NonNullable<typeof c> => Boolean(c)),
        ),
      ];
      /*
        One class resolves against its own row; several resolve at jurisdiction level. Passing
        them all at once matches several equally specific rows and reports a configuration
        error for a cinema that is entirely correctly configured — the same trap the
        compliance screen documents. Each ticket type is still priced against its OWN class
        below, which is where the ceiling actually applies.
      */
      const resolution = await this.policies.resolveForCinema(
        cinema,
        currency,
        classes.length === 1 ? classes : [],
        at,
        unmapped,
      );

      if (blocksBooking(resolution.status)) {
        blockers.push(
          unmapped.length > 0
            ? {
                code: 'SEAT_CLASS_UNMAPPED',
                message:
                  `The show on ${when} cannot be sold: ${unmapped.join(', ')} ` +
                  `${unmapped.length === 1 ? 'is' : 'are'} not mapped to a regulatory seat ` +
                  `class, and this jurisdiction caps the price of each class.`,
                fix:
                  'Open the cinema’s readiness page and map every seat category to a ' +
                  'regulatory class (Regular, Recliner, Premium or Non-premium).',
                fixPath: '/organizer/cinemas',
                eventSessionId: session.id,
                subject: unmapped.join(', '),
              }
            : {
                code: 'REGULATORY_PRICING_UNRESOLVED',
                message: `The show on ${when} cannot be sold: ${resolution.explanation}`,
                fix: 'Check the cinema’s jurisdiction and classification on its readiness page.',
                fixPath: '/organizer/cinemas',
                eventSessionId: session.id,
              },
        );
        // The ceilings cannot be read from an unresolved policy, so there is nothing further
        // to say about this show until the resolution itself is fixed.
        continue;
      }

      for (const ticket of session.ticketTypes) {
        const own = ticket.seatCategory?.regulatoryClass
          ? await this.policies.resolveForCinema(
              cinema,
              currency,
              [ticket.seatCategory.regulatoryClass],
              at,
            )
          : resolution;
        const check = checkTicketPrice(own, ticket.priceMinor);
        if (!check.ok) {
          blockers.push({
            code: 'PRICE_OVER_CEILING',
            message:
              `The show on ${when} cannot be sold at its current prices. ${ticket.name} is ` +
              `priced above what its seat class permits. ${check.reason ?? ''}`.trim(),
            fix: 'Lower the price to the permitted maximum, or map the seat to the correct class.',
            fixPath: `/organizer/events/${eventId}/sessions`,
            eventSessionId: session.id,
            subject: ticket.name,
          });
        }
      }
    }

    return {
      eventId,
      sellable: blockers.length === 0,
      blockers,
      warnings,
      checkedAt: at.toISOString(),
    };
  }
}
