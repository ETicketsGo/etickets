import { Injectable, Optional } from '@nestjs/common';
import { TAX_CATEGORY_LABELS, blocksBooking, isTaxCategory } from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { currencyForCountry } from '../common/country';
import { CinemaPricingPolicyService } from '../pricing/cinema-policy/cinema-pricing-policy.service';
import { checkTicketPrice } from '../pricing/cinema-policy/apply-policy';
import { placePosition, unmappedSeatClassMessage } from '../pricing/cinema-policy/sale-eligibility';
import { admissionClassificationGaps, selectTaxRules } from '../pricing/tax-calculator';
import { taxRuleFromRow } from '../tax/tax-rule-row';
import { ticketTaxCategory } from '../bookings/sale-tax-place';
import { showTimezone } from '../spaces/space-owner';

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
  /** The jurisdiction prices by classification and this cinema has none. The organizer fixes it. */
  | 'CINEMA_NOT_CLASSIFIED'
  /** No policy covers this jurisdiction. Only the platform can write one. */
  | 'NO_PRICING_POLICY'
  /** Two equally specific policies match. Only the platform can resolve it. */
  | 'PRICING_POLICY_CONFLICT'
  /** Anything else that blocks pricing. Treated as the platform's, because we do not know. */
  | 'REGULATORY_PRICING_UNRESOLVED'
  | 'SEAT_CLASS_UNMAPPED'
  | 'PRICE_OVER_CEILING'
  | 'FREE_EVENT_HAS_PRICES'
  | 'SEATED_SESSION_HAS_NO_SEATS'
  | 'CURRENCY_DISAGREES_WITH_VENUE'
  /** Tax here depends on what the event is, and it has no tax classification. */
  | 'TAX_CLASSIFICATION_MISSING'
  /** It is classified, but no active tax rule covers that classification at this price. */
  | 'TAX_RULE_NOT_FOUND';

/**
 * Who can actually put this right.
 *
 * ── WHY THIS FIELD HAD TO EXIST ────────────────────────────────────────────────────
 * Three different failures used to produce one card, with one message and one link to the
 * cinema readiness page. Only one of them could be fixed there.
 *
 * An organizer in Hyderabad saw "cannot be sold: India has active cinema pricing policies but
 * none covers Telangana" and, underneath it, "Go and fix this". Nothing on that page — or on
 * any page they can reach — writes a pricing policy for a state. The rates are not ours to
 * invent; they come from a government order. So the platform sent somebody to look for a
 * control that does not exist, and the honest reading of their time is that we wasted it.
 */
export type SellabilityOwner = 'ORGANIZER' | 'PLATFORM';

export interface SellabilityIssue {
  code: SellabilityCode;
  /** Who can fix it. Determines whether a fix link is offered at all. */
  owner: SellabilityOwner;
  /** What is wrong, in the organizer's vocabulary. Never an internal status name. */
  message: string;
  /** What to do about it. A problem statement without one is a complaint. */
  fix: string;
  /** Where to go, relative to the organizer console. Null when there is no single screen. */
  fixPath: string | null;
  /**
   * Set only when exactly one show is affected. A single id beside a count of 148 would
   * suggest the other 147 were something else.
   */
  eventSessionId?: string;
  /**
   * How many shows carry this same fault.
   *
   * A 148-show event with one misconfigured jurisdiction used to render 148 identical cards,
   * each naming a different date, and the reader had to compare them to discover they were
   * one problem. The count says it in a word.
   */
  affectedSessions: number;
  /** Named so the organizer knows WHICH category or ticket type, not merely that one is bad. */
  subject?: string;
  /**
   * The shows that carry this fault, each with the zone it should be read in.
   *
   * The count alone says how big the problem is and nothing about WHICH shows, so an
   * organizer told "18 shows affected" had to open every date to find them. Listed here so a
   * notification can name them without a second query, and empty for event-level faults that
   * belong to no show at all.
   */
  sessions: SellabilitySession[];
}

/** One affected show, as the notification centre lists it. */
export interface SellabilitySession {
  id: string;
  startsAt: string;
  /** The show's zone by `showTimezone` (the venue's first). Null when nobody knows. */
  timeZone: string | null;
}

/** An issue as detected, before identical ones are folded together. */
type RawIssue = Omit<SellabilityIssue, 'affectedSessions' | 'sessions'> & {
  /** The show it was found on, carried to the fold and no further. */
  session?: SellabilitySession;
};

/**
 * Fold identical faults into one.
 *
 * Grouped on everything that makes the fault what it is — code, owner, subject and the
 * sentence itself — so two jurisdictions, or two unmapped seat categories, stay two cards.
 * Only genuine repetition collapses, which is why the messages below name no dates: a date
 * would make 148 identical faults look like 148 different ones.
 */
function fold(raw: RawIssue[]): SellabilityIssue[] {
  const byKey = new Map<string, SellabilityIssue>();
  for (const issue of raw) {
    /*
      The fix path is part of the identity too. Two cinemas with the same unmapped category
      are two places to go and fix it, and folding them would send the organizer to one and
      leave the other broken.
    */
    const key = [
      issue.code,
      issue.owner,
      issue.subject ?? '',
      issue.message,
      issue.fixPath ?? '',
    ].join('\u0000');
    const { session, ...rest } = issue;
    const seen = byKey.get(key);
    if (seen) {
      seen.affectedSessions += 1;
      if (session) seen.sessions.push(session);
      // No longer about one show, so the single id would misrepresent the rest.
      delete seen.eventSessionId;
      continue;
    }
    byKey.set(key, { ...rest, affectedSessions: 1, sessions: session ? [session] : [] });
  }
  return [...byKey.values()];
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

  /**
   * What a cinema screen's seat classes mean for selling there, asked BEFORE an event exists.
   *
   * The create wizard used to say "Setup complete" for a seated event on a cinema screen whose
   * categories had no regulatory class, and the event then could not sell. This is the same
   * resolver `check` and checkout use, asked with the layout's own categories, so the wizard
   * can say which categories need a class (and link to the control) before anything is saved,
   * or that no class would help because no rule covers the place yet.
   *
   * - `NONE`: nothing to do (not regulated, or every category mapped and resolving).
   * - `MAP_CLASSES`: a rule covers the place and `unmapped` categories need a class.
   * - `NO_RULES`: no rule covers the place yet; mapping would not open the sale.
   * - `BLOCKED`: another regulatory gap only the platform or the cinema's type can close.
   */
  async seatClassNeeds(
    cinema: {
      id: string;
      country: string | null;
      region: string | null;
      district: string | null;
      city: string | null;
      localBodyType: Parameters<CinemaPricingPolicyService['resolveForCinema']>[0]['localBodyType'];
      cinemaFormat: Parameters<CinemaPricingPolicyService['resolveForCinema']>[0]['cinemaFormat'];
      climateType: Parameters<CinemaPricingPolicyService['resolveForCinema']>[0]['climateType'];
      venue?: { country: string | null; region: string | null; city: string | null } | null;
    },
    categories: { name: string; regulatoryClass: string | null }[],
    at: Date = new Date(),
  ): Promise<{
    state: 'NONE' | 'MAP_CLASSES' | 'NO_RULES' | 'BLOCKED';
    unmapped: string[];
    fixPath: string | null;
  }> {
    const none = { state: 'NONE' as const, unmapped: [], fixPath: null };
    if (!this.policies) return none;
    const unmapped = [...new Set(categories.filter((c) => !c.regulatoryClass).map((c) => c.name))];
    const country = cinema.country ?? cinema.venue?.country ?? null;
    /*
      Asked with at least one unmapped name, so the resolver's first answer is the one wanted
      here: a place a rule covers refuses as INVALID_CINEMA_CLASSIFICATION, a place none covers
      as POLICY_NOT_FOUND, and an unregulated one is NOT_REGULATED. With every category mapped
      the probe name stands in, and only "no rules here" is reported from it: the rest of the
      mapped configuration is the event's own check, once the event and its prices exist.
    */
    const resolution = await this.policies.resolveForCinema(
      cinema,
      currencyForCountry(country) ?? 'INR',
      [],
      at,
      unmapped.length > 0 ? unmapped : ['(every category mapped)'],
    );
    if (!blocksBooking(resolution.status)) return none;
    if (resolution.status === 'POLICY_NOT_FOUND') {
      return { state: 'NO_RULES', unmapped: [], fixPath: null };
    }
    if (unmapped.length === 0) return none;
    if (resolution.status === 'INVALID_CINEMA_CLASSIFICATION') {
      return {
        state: 'MAP_CLASSES',
        unmapped,
        fixPath: `${cinemaReadinessPath(cinema.id)}#seat-classes`,
      };
    }
    return { state: 'BLOCKED', unmapped: [], fixPath: cinemaReadinessPath(cinema.id) };
  }

  async check(eventId: string, at: Date = new Date()): Promise<SellabilityReport> {
    const blockers: RawIssue[] = [];
    const warnings: RawIssue[] = [];

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        isFree: true,
        taxCategory: true,
        venue: { select: { country: true, region: true, timezone: true } },
        organization: { select: { registeredCountry: true, registeredRegion: true } },
        sessions: {
          select: {
            id: true,
            startsAt: true,
            seatMapId: true,
            screenId: true,
            screen: {
              select: {
                // The space's own venue, for the show's zone (`showTimezone`).
                venue: { select: { timezone: true, country: true } },
                cinema: {
                  select: {
                    id: true,
                    timezone: true,
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
                taxCategory: true,
                seatCategory: { select: { name: true, regulatoryClass: true } },
              },
            },
            _count: { select: { showSeats: true } },
          },
        },
      },
    });

    if (!event) {
      return { eventId, sellable: false, blockers: [], warnings: [], checkedAt: at.toISOString() };
    }

    /*
      Read once for the whole event. Active rules only: with GST switched off - every
      environment today - this is empty and no tax issue can be reported.
    */
    const taxRules = (await this.prisma.taxRule.findMany({ where: { active: true } })).map(
      taxRuleFromRow,
    );

    if (event.sessions.length === 0) {
      blockers.push({
        code: 'NO_SESSIONS',
        owner: 'ORGANIZER',
        message: 'This event has no dates, so there is nothing to sell.',
        fix: 'Add at least one show date.',
        fixPath: `/organizer/events/${eventId}/sessions`,
      });
    }

    for (const session of event.sessions) {
      const shown: SellabilitySession = {
        id: session.id,
        startsAt: session.startsAt.toISOString(),
        timeZone: showTimezone(session.screen, event.venue),
      };
      if (session.ticketTypes.length === 0) {
        blockers.push({
          code: 'NO_TICKET_TYPES',
          owner: 'ORGANIZER',
          message: 'This show has no ticket types, so nobody can buy anything for it.',
          fix: 'Add at least one ticket type to this show.',
          fixPath: `/organizer/events/${eventId}/sessions`,
          eventSessionId: session.id,
          session: shown,
        });
        continue;
      }

      /*
        A room with a seat map but no seats laid down. The storefront renders an empty map
        and every seat click does nothing, which reads as a broken page rather than as an
        unfinished one.

        Keyed on the ROOM as well as the pinned layout, because the room is what makes a
        session seated at checkout (`Boolean(screenId)`). A session with a room and no pin —
        which is what duplicating an event used to produce — sold nothing and passed this
        check, since it only looked at `seatMapId`.
      */
      if ((session.seatMapId || session.screenId) && session._count.showSeats === 0) {
        blockers.push({
          code: 'SEATED_SESSION_HAS_NO_SEATS',
          owner: 'ORGANIZER',
          message: 'This show uses a seat map but has no seats on sale.',
          fix: 'Re-assign the space to this show, or publish a layout that has seats in it.',
          fixPath: `/organizer/events/${eventId}/sessions`,
          eventSessionId: session.id,
          session: shown,
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
            owner: 'ORGANIZER',
            message:
              'This is a free event, but ' +
              `${priced.map((t) => t.name).join(', ')} still carries a price.`,
            fix: 'Set every ticket type to zero, or turn off the free-event setting.',
            fixPath: `/organizer/events/${eventId}`,
            eventSessionId: session.id,
            session: shown,
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
            owner: 'ORGANIZER',
            message:
              `This show is priced in ${mismatched.join(', ')}, but its venue is in ` +
              `a country that sells in ${venueCurrency}.`,
            fix:
              `Re-price the ticket types in ${venueCurrency}, or correct the venue's country ` +
              `if the venue is not where it says it is.`,
            fixPath: `/organizer/events/${eventId}/sessions`,
            eventSessionId: session.id,
            session: shown,
            subject: mismatched.join(', '),
          });
        }
      }

      /*
        ── TAX CLASSIFICATION ─────────────────────────────────────────────────────────
        The same question checkout asks (`admissionClassificationGaps`), with the same rules
        and the same place, asked per ticket type at its list price. Checkout refuses such a
        sale rather than taxing it at an assumed rate; this says so to the organizer first.
      */
      for (const ticket of session.ticketTypes) {
        const category = ticketTaxCategory(ticket, event);
        const applicable = selectTaxRules(taxRules, {
          country: event.venue?.country ?? event.organization?.registeredCountry ?? null,
          region: event.venue?.region ?? event.organization?.registeredRegion ?? null,
          currency: ticket.currency,
          at,
        });
        const [gap] = admissionClassificationGaps(applicable, [
          { unitPriceMinor: ticket.priceMinor, quantity: 1, category },
        ]);
        if (!gap) continue;
        if (gap.code === 'TAX_CLASSIFICATION_MISSING') {
          // About the EVENT, so no ticket name: one card however many shows and tickets.
          blockers.push({
            code: 'TAX_CLASSIFICATION_MISSING',
            owner: 'ORGANIZER',
            message:
              'Tax where this event is held depends on what kind of event it is, and this ' +
              'event has no tax classification.',
            fix:
              'Edit the event and choose its tax classification, for example Cinema, Live ' +
              'performance or Recognised sporting event.',
            // The edit page, where the classification is chosen.
            fixPath: `/organizer/events/${eventId}/edit`,
            eventSessionId: session.id,
            session: shown,
          });
        } else {
          const label = isTaxCategory(gap.category)
            ? TAX_CATEGORY_LABELS[gap.category].label
            : (gap.category ?? '');
          blockers.push({
            code: 'TAX_RULE_NOT_FOUND',
            owner: 'PLATFORM',
            message: `No tax rate is set up for "${label}" tickets at this price.`,
            fix:
              'The platform team must set up this tax rate before it can be sold. If the ' +
              'classification is wrong, edit the event and choose the right one.',
            fixPath: `/organizer/events/${eventId}/edit`,
            eventSessionId: session.id,
            session: shown,
            subject: label,
          });
        }
      }

      // ── Regulated pricing. Only cinema sessions have any of this. ──
      const cinema = session.screen?.cinema;
      if (!cinema || !this.policies) continue;
      const policies = this.policies;

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
        /*
          Unmapped classes are the cause only when the resolver said so. Where no rule covers
          the place at all, it answers POLICY_NOT_FOUND even with classes unmapped (see
          `coversPlace`), and sending the organizer to map them would not open the sale.
        */
        /*
          An unmapped category is refused before the resolver looks for a rule, so the place's
          own position is still unknown. Asked once more without them - for the words, and to
          report a refusal that would remain after the mapping (Telangana: no rules at all). It
          never makes the show sellable: the show is already blocked.
        */
        const place =
          unmapped.length > 0 && resolution.status === 'INVALID_CINEMA_CLASSIFICATION'
            ? await placePosition((cls) => policies.resolveForCinema(cinema, currency, cls, at, []))
            : null;
        const placeName =
          cinema.region?.trim() ||
          cinema.venue?.region?.trim() ||
          cinema.city?.trim() ||
          'this area';
        blockers.push(
          unmapped.length > 0 && resolution.status === 'INVALID_CINEMA_CLASSIFICATION'
            ? {
                code: 'SEAT_CLASS_UNMAPPED',
                owner: 'ORGANIZER',
                message: unmappedSeatClassMessage(unmapped, placeName, place?.status ?? null),
                fix:
                  'Open Seat classes for this cinema and choose a regulatory class for each ' +
                  'seat category (Regular, Recliner, Premium or Non-premium).',
                /*
                  Straight to the mapping control on the cinema's readiness page. The bare
                  list made the organizer pick the right cinema out of all of theirs, and the
                  page top made them scroll past a dozen checks to find it.
                */
                fixPath: `${cinemaReadinessPath(cinema.id)}#seat-classes`,
                eventSessionId: session.id,
                session: shown,
                subject: unmapped.join(', '),
              }
            : regulatoryIssue(
                resolution.status,
                resolution.explanation,
                shown,
                cinema.id,
                cinema.city ?? cinema.venue?.city ?? cinema.region ?? cinema.venue?.region,
              ),
        );
        if (place && blocksBooking(place.status)) {
          blockers.push(regulatoryIssue(place.status, place.explanation, shown, cinema.id));
        }
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
            owner: 'ORGANIZER',
            message:
              `${ticket.name} is priced above what its seat class permits. ` +
              `${check.reason ?? ''}`.trim(),
            fix: 'Lower the price to the permitted maximum, or map the seat to the correct class.',
            fixPath: `/organizer/events/${eventId}/sessions`,
            eventSessionId: session.id,
            session: shown,
            subject: ticket.name,
          });
        }
      }
    }

    return {
      eventId,
      sellable: blockers.length === 0,
      blockers: fold(blockers),
      warnings: fold(warnings),
      checkedAt: at.toISOString(),
    };
  }
}

/**
 * A blocked pricing resolution, attributed to whoever can actually act on it.
 *
 * ── WHY THE STATUS IS READ RATHER THAN THE MESSAGE ─────────────────────────────────
 * The resolver already tells these apart and always did; this service was throwing that away
 * and printing one sentence with one link for all of them. The distinction is not cosmetic:
 * one of these is a field on a form the organizer owns, and the others need a government
 * order read and a policy written by whoever runs the platform.
 *
 * The default is PLATFORM on purpose. A blocking status nobody has classified is one this
 * code does not understand, and sending an organizer to hunt for a control we cannot name is
 * the failure being fixed here. Silence is better than a wrong instruction.
 */
function regulatoryIssue(
  status: string,
  explanation: string,
  session: SellabilitySession,
  cinemaId?: string | null,
  place?: string | null,
): RawIssue {
  const eventSessionId = session.id;
  if (status === 'INVALID_CINEMA_CLASSIFICATION') {
    /*
      The PLATFORM's: a cinema's legal type decides its price limit, so organizers cannot set it
      (see `CinemasService`). The readiness page is still the place to go, because that is where
      the organizer sees the legal type on record and asks ETicketsGo to change it.
    */
    return {
      code: 'CINEMA_NOT_CLASSIFIED',
      owner: 'PLATFORM',
      message:
        "This area sets ticket prices by the cinema's legal type (local body, format and " +
        'cooling), and this cinema has none on record yet.',
      fix:
        'Only ETicketsGo can set the legal type. Open the cinema’s readiness page and use ' +
        '"Ask ETicketsGo to change this" under Regulatory pricing.',
      fixPath: cinemaReadinessPath(cinemaId),
      eventSessionId,
      session,
    };
  }
  if (status === 'POLICY_CONFIGURATION_ERROR') {
    return {
      code: 'PRICING_POLICY_CONFLICT',
      owner: 'PLATFORM',
      message: explanation,
      fix:
        'Nothing here can fix this — two platform pricing rules contradict each other. ' +
        'The platform team has been told.',
      fixPath: null,
      eventSessionId,
      session,
    };
  }
  if (status === 'POLICY_NOT_FOUND') {
    /*
      Said in words, and with the one way out the organizer does have. The resolver's sentence
      ("India has active cinema pricing policies but none covers ...") is for an audit. A space
      that is not a cinema screen is not under cinema price rules, so an event that is not a
      film can move there and sell today.
    */
    const where = place?.trim() || 'this area';
    return {
      code: 'NO_PRICING_POLICY',
      owner: 'PLATFORM',
      message:
        `Cinema screens in ${where} cannot sell online yet: there are no state ticket price ` +
        `rules on record for ${where}. Mapping seat classes will not change this.`,
      fix:
        'ETicketsGo has to add the price rules first. To sell this event now, hold it in a ' +
        'space at the venue that is not a cinema screen.',
      fixPath: null,
      eventSessionId,
      session,
    };
  }
  return {
    code: 'REGULATORY_PRICING_UNRESOLVED',
    owner: 'PLATFORM',
    message: explanation,
    /*
      Deliberately does not ask the organizer to do anything. Ticket ceilings come from a
      government order; the rates are not ours to invent and not theirs to enter. Saying so
      plainly is more use than a link to a page with no such control on it.
    */
    fix:
      'Nothing here can fix this — ticket prices in this jurisdiction are set by a ' +
      'government order the platform has not been able to configure yet. The platform team ' +
      'has been told, and this event can be published once it is.',
    fixPath: null,
    eventSessionId,
    session,
  };
}

/** One cinema's readiness page when we know which cinema, else the list of them. */
function cinemaReadinessPath(cinemaId?: string | null): string {
  return cinemaId ? `/organizer/cinemas/${cinemaId}/readiness` : '/organizer/cinemas';
}
