import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { feeTaxSummary } from '../pricing/fee-tax';
import {
  BookingItemKind,
  BookingStatus,
  EventStatus,
  FeeMode,
  PaymentStatus,
  SessionStatus,
  priceBundle,
  OrganizationStatus,
} from '@eticketsgo/shared-types';
import {
  SHOW_ZONE_SCREEN_SELECT,
  showTimezone,
  type ShowZoneScreen,
  type ShowZoneVenue,
} from '../spaces/space-owner';
import type { InventoryLine } from '../inventory/inventory-strategy.interface';
import type { CreateBookingInput, QuoteBookingInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { PricingStrategiesService } from '../pricing/pricing-strategies.service';
import { computeCouponDiscountMinor } from '../pricing/coupon-pricing';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { cancelPendingBooking, expirePendingBooking } from '../inventory/expire-pending-booking';
import { AddOnInventoryService, type AddOnLine } from '../commerce/addon-inventory.service';
import { onSale } from '../commerce/addons.service';
import { AppException, ErrorCodes } from '../common/errors';
import { isUniqueViolation } from '../events/request-key';
import {
  BookingHoldLimitsService,
  aggregateTicketQuantities,
  assertOrderSize,
  holdLimitsFrom,
} from './booking-hold-limits';
import {
  IDEMPOTENCY_IN_PROGRESS,
  IDEMPOTENCY_KEY_REUSED,
  bookingIdempotency,
  type BookingIdempotency,
} from './booking-idempotency';
import { resolveCommerceCurrency } from '../common/commerce-currency';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';
import { InventoryLockShadowService } from '../inventory/locking/inventory-lock-shadow.service';
import { BookingShadowObserver } from './orchestration/booking-shadow-observer.service';
import { PaymentsService } from '../payments/payments.service';
import { PendingPaymentRecoveryService } from '../payments/recovery/pending-payment-recovery.service';
import { CinemaPricingPolicyService } from '../pricing/cinema-policy/cinema-pricing-policy.service';
import { PilotGuardService } from '../pilot/pilot-guard.service';
import type { PilotSale } from '../pilot/pilot-config';
import {
  admissionLinesFromItems,
  saleTaxPlace,
  taxAdmissionLines,
  ticketTaxCategory,
} from './sale-tax-place';
import type { PolicyEffect } from '../pricing/cinema-policy/apply-policy';
import {
  BUYER_SALE_NOT_OPEN,
  SALE_NOT_OPEN_REASON,
  resolveCinemaPolicy,
  saleBlockersFromPolicy,
  type AdmissionLine,
  type CinemaPolicyOutcome,
  type PolicyCinema,
} from '../pricing/cinema-policy/sale-eligibility';

/**
 * Proof, established by the caller, that the request comes from the guest checkout session
 * that created a guest booking. Only `BookingExecutionRouter` sets it, after
 * `GuestSessionVerifier` answered BOUND. See `BookingsService.assertMayChangeUnpaid`.
 */
export interface GuestMutationAccess {
  guestSessionVerified?: boolean;
}

/** A resolved BookingItem row plus the holds it needs, produced by commerce expansion. */
interface CommerceResolution {
  itemCreates: Prisma.BookingItemCreateWithoutBookingInput[];
  subtotalMinor: number;
  addOnHolds: AddOnLine[];
  ticketHolds: InventoryLine[];
}

/**
 * Fallback hold window when configuration is absent, in minutes.
 *
 * The real value comes from `BOOKING_HOLD_MINUTES` (validated in configuration.ts, bounded
 * 1–60). This constant exists only so a unit test that constructs the service without a
 * ConfigService still gets the historical behaviour rather than a hold of `NaN` minutes,
 * which would produce an Invalid Date and a hold that never expires.
 */
const DEFAULT_HOLD_MINUTES = 10;

/**
 * How many times a buyer may ask for more time before the hold is final.
 *
 * ── WHY TEN, AND WHY IT IS CONFIGURABLE ────────────────────────────────────────────
 * WCAG 2.2.1 (Timing Adjustable, Level A) offers three ways to satisfy it, and the only one
 * that fits a seat hold is "extend": warn before it expires, let the buyer extend with a
 * simple action, and allow it at least TEN times. So ten is the compliant default, not a
 * number somebody liked.
 *
 * It is configurable because ten extensions is real inventory risk on a high-demand on-sale,
 * and that is an operator's judgement rather than ours. Lowering it is a deliberate
 * trade — see `docs/accessibility/README.md`, which records that going below ten forfeits
 * the "extend" route and would rest on the criterion's "essential" exception, which is an
 * argument for an auditor to accept rather than for us to assert.
 */
const DEFAULT_MAX_HOLD_EXTENSIONS = 10;

/**
 * How long a request waits for an earlier one with the same idempotency key to finish, and how
 * often it looks. A booking create normally takes well under a second; five covers a slow one
 * without holding a request open for long when the first one has died.
 */
const IDEMPOTENCY_WAIT_MS = 5_000;
const IDEMPOTENCY_POLL_MS = 150;

@Injectable()
export class BookingsService {
  private readonly logger = new Logger('Bookings');

  /**
   * How long an unpaid booking holds inventory.
   *
   * Read once at construction rather than per booking: it is process configuration, and
   * re-reading it mid-flight would let two bookings created a second apart disagree about
   * the window. Restarting to change it is the correct cost.
   */
  private get holdMinutes(): number {
    const configured = this.config?.get<number>('BOOKING_HOLD_MINUTES');
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_HOLD_MINUTES;
  }

  /** See DEFAULT_MAX_HOLD_EXTENSIONS for why ten, and why an operator may change it. */
  private get maxHoldExtensions(): number {
    const configured = this.config?.get<number>('BOOKING_HOLD_MAX_EXTENSIONS');
    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_MAX_HOLD_EXTENSIONS;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly pricingStrategies: PricingStrategiesService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly addOnInventory: AddOnInventoryService,
    private readonly metrics: MetricsService,
    // Shadow-mode distributed lock observer (ADR-039). No-op unless
    // INVENTORY_LOCKS_ENABLED + mode=shadow; never affects booking correctness.
    private readonly lockShadow: InventoryLockShadowService,
    // Shadow-mode booking orchestration observer (ADR-042). No-op unless
    // BOOKING_ORCHESTRATOR_ENABLED + mode=shadow; never affects booking correctness.
    private readonly bookingShadow: BookingShadowObserver,
    // Optional so the many unit tests that construct this service directly are not all
    // forced to supply a ConfigService for one number; holdMinutes falls back safely.
    @Optional() private readonly config?: ConfigService,

    /*
      Confirming a free booking, which has no payment to wait for.

      Optional for the same reason as the config: dozens of unit tests build this service by
      hand and none of them book a free event. A priced booking never reaches it, and a free
      one without it would sit PENDING_PAYMENT forever — so the free path asserts it is here
      rather than silently doing nothing.
    */
    @Optional() private readonly payments?: PaymentsService,
    /*
      GENUINELY last in the list, and `@Optional()`.

      Position matters: every hand-built test harness constructs this service positionally,
      so inserting a parameter anywhere but the end silently shifts each of their arguments
      one slot along. It did — eleven tests failed with "resolve is not a function", which was
      a ConfigService sitting where this belongs. A new optional dependency goes on the end.

      Absent, cinema pricing resolves NOT_REGULATED and the platform prices exactly as it did
      before this subsystem existed.
    */
    @Optional() private readonly policyService?: CinemaPricingPolicyService,

    /*
      ON THE END, for the reason stated immediately above.

      The expiry guard (2026-10-06 incident). Absent, the sweep behaves exactly as it did
      before - which is the behaviour that released a paid booking's inventory - so the
      wiring is what makes the guard real. `bookings.module` imports `PaymentsModule`, which
      exports this, so the running application always has it; the optionality is purely so
      the hand-built test harnesses above keep compiling.
    */
    @Optional() private readonly recovery?: PendingPaymentRecoveryService,

    /*
      ON THE END, as above. The controlled India pilot's limits (apps/api/src/pilot). Absent, or
      present with PILOT_MODE unset, the quote and the booking are exactly what they were.
    */
    @Optional() private readonly pilot?: PilotGuardService,

    /*
      ON THE END, as above. The active-hold limits (booking-hold-limits.ts): how many unpaid
      holds one account, guest address or client IP may have open at once. `BookingsModule`
      provides it, so the running application always has it (bookings.module.spec.ts pins
      that); absent, only the hand-built test harnesses run, and they book one order at a time.
    */
    @Optional() private readonly holdLimits?: BookingHoldLimitsService,
  ) {}

  /**
   * Creates a PENDING_PAYMENT booking with an atomic, oversell-proof inventory
   * hold. Fee amounts are snapshotted onto the booking so later rule changes
   * never alter historical orders.
   */
  async create(
    user: RequestUser | null,
    input: CreateBookingInput,
    idempotencyKey?: string,
    hooks?: { inHoldTx?: (tx: Prisma.TransactionClient, bookingId: string) => Promise<void> },
    /**
     * A sale made by the organizer's own staff at the counter (`CounterSalesService`), paid in
     * cash in front of them and collected straight after this returns. Never set from a
     * request body: only that service passes it, after checking the caller is staff of the
     * session's organization.
     */
    opts?: {
      counterSale?: boolean;
      /**
       * The caller's address, for the per-IP hold limit. Resolved by the controller with the
       * same trusted-header rule the rate limiter uses (`common/client-ip.ts`); absent for a
       * caller that is not an HTTP request, which is then not counted by address.
       */
      clientIp?: string | null;
    },
  ) {
    /*
      Scoped to the buyer and bound to the body - see booking-idempotency.ts for the two bugs a
      global scope caused. A completed replay is answered here; one still in progress is waited
      for. The key is CLAIMED inside the transaction below.
    */
    const idem: BookingIdempotency | null = idempotencyKey
      ? bookingIdempotency({
          rawKey: idempotencyKey,
          userId: user?.id ?? null,
          buyerEmail: input.buyerEmail,
          body: input,
          counterSale: opts?.counterSale,
        })
      : null;
    if (idem) {
      const earlier = await this.replayFor(idem);
      if (earlier) return earlier;
    }

    const session = await this.prisma.eventSession.findUnique({
      where: { id: input.eventSessionId },
      include: {
        event: {
          include: {
            // Tax jurisdiction, for whenever an owner configures a TaxRule. The venue is
            // the place of supply for an admission — the sale happens where the show is,
            // not where the company is registered — so it is consulted first, and the
            // organization's registered address is only the fallback for an event with no
            // venue on file.
            venue: { select: { country: true, region: true, city: true } },
            organization: {
              select: {
                registeredCountry: true,
                registeredRegion: true,
                // Whether this organizer takes cash at the venue. Read from the org, never
                // trusted from the request — otherwise anybody could reserve seats for free.
                cashPaymentsEnabled: true,
                // Suspended means stop selling; see the guard below.
                status: true,
                name: true,
              },
            },
          },
        },
        /*
          The cinema, for regulatory pricing. Its jurisdiction and classification are what a
          cinema pricing policy matches on — and they live on the CINEMA rather than the
          venue because one venue can host cinemas classified differently, and a cinema can
          exist before a venue is attached to it.

          Null for every non-cinema session, which is what makes those orders resolve as
          NOT_REGULATED and price exactly as they always have.
        */
        screen: {
          select: {
            cinema: {
              select: {
                id: true,
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
      },
    });
    if (!session) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Session not found.', HttpStatus.NOT_FOUND);
    }
    /*
      ── A SUSPENDED ORGANIZER STOPS SELLING, HERE ──────────────────────────────────────
      `SUSPENDED` has been in the schema since the beginning with nothing writing it and
      nothing reading it, so an admin had no way to stop an organizer at all - and a suspend
      button that left their events on sale would have been worse than no button.

      Checked at the booking rather than by unpublishing their events: unpublishing loses
      what the organizer set up and has to be undone event by event, while this stops the
      money the moment the decision is made and resumes it the moment it is reversed.

      Deliberately not EVENT_NOT_PUBLISHED. The event is fine; the customer is told the
      organizer is not selling right now, which is true and is not the customer's fault.
    */
    this.assertOrganizerSelling(session.event.organization);
    if (
      session.event.status !== EventStatus.PUBLISHED ||
      session.status !== SessionStatus.SCHEDULED
    ) {
      throw new AppException(
        ErrorCodes.EVENT_NOT_PUBLISHED,
        'This event is not available for booking.',
        HttpStatus.CONFLICT,
      );
    }
    /*
      A session that has already started is not for sale, whatever its status says.

      Nothing moves a session to COMPLETED at its start time, so a multi-date run keeps its
      past dates SCHEDULED — and a stale page or a direct POST to /bookings/guest could book
      last Tuesday's show. A cash reservation would have been held "until the show starts",
      which is already in the past.
    */
    this.assertSessionNotStarted(session.startsAt);

    // Release any expired holds for this session so freed stock is bookable.
    await this.releaseExpiredHolds(input.eventSessionId);

    const ticketTypeIds = input.items.map((i) => i.ticketTypeId);
    const ticketTypes = await this.prisma.ticketType.findMany({
      where: { id: { in: ticketTypeIds }, eventSessionId: input.eventSessionId },
      // The seat category's REGULATORY class, not its display name. A rate order bands on
      // fixed classes; "Gold" is a marketing label that has to be mapped to one.
      include: { seatCategory: { select: { name: true, regulatoryClass: true } } },
    });
    const byId = new Map(ticketTypes.map((t) => [t.id, t]));

    const now = new Date();
    /*
      `maxPerOrder` is a limit on the ORDER, so it is checked against the order's total for the
      type. Checked per line it was bypassed by sending one ticket type as several lines - see
      `aggregateTicketQuantities` for why the lines are added up rather than refused or merged.
    */
    const quantityByType = aggregateTicketQuantities(input.items);
    for (const item of input.items) {
      const tt = byId.get(item.ticketTypeId);
      if (!tt) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'One or more ticket types are invalid for this session.',
          HttpStatus.BAD_REQUEST,
        );
      }
      this.assertTicketTypeActive(tt);
      if ((quantityByType.get(item.ticketTypeId) ?? item.quantity) > tt.maxPerOrder) {
        throw new AppException(
          ErrorCodes.VALIDATION_FAILED,
          `You can book at most ${tt.maxPerOrder} of ${tt.name} per order.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if ((tt.salesStartAt && tt.salesStartAt > now) || (tt.salesEndAt && tt.salesEndAt < now)) {
        throw new AppException(
          ErrorCodes.CONFLICT,
          `${tt.name} is not currently on sale.`,
          HttpStatus.CONFLICT,
        );
      }
    }

    /*
      Reserved seating, decided by the ROOM this session is in.

      ── WHY NOT BY THE KIND OF EVENT ───────────────────────────────────────────────
      This used to read `experienceType === MOVIE`, which meant a cinema showing had a seat
      map and nothing else could — a concert in a 400-seat theatre could only sell numbered
      quantities of a ticket type. That conflated two different questions. Whether a ticket
      names a seat depends on the room: the same concert is reserved seating in a theatre and
      general admission in a standing arena.

      A session with a room (`screenId`) sells seats; one without sells a count. Movies always
      have a room, so nothing about them changes.

      Every line must then carry seats that belong to this session and match their ticket
      type's price category. Actual availability is enforced atomically by the strategy's
      conditional hold.
    */
    const isSeatBased = Boolean(session.screenId);
    if (isSeatBased) {
      const reservedItems = input.items.filter((item) => !byId.get(item.ticketTypeId)?.seatZoneId);
      const allSeatIds = reservedItems.flatMap((i) => i.seatIds ?? []);
      for (const item of input.items) {
        const ticketType = byId.get(item.ticketTypeId)!;
        if (ticketType.seatZoneId) {
          if (item.seatIds?.length) {
            throw new AppException(
              ErrorCodes.VALIDATION_FAILED,
              'Standing-area tickets do not use seat numbers.',
              HttpStatus.BAD_REQUEST,
            );
          }
        } else if (!item.seatIds || item.seatIds.length !== item.quantity) {
          throw new AppException(
            ErrorCodes.VALIDATION_FAILED,
            'Please select a seat for each ticket.',
            HttpStatus.BAD_REQUEST,
          );
        }
      }
      const seats = await this.prisma.seat.findMany({
        where: { id: { in: allSeatIds } },
        select: { id: true, seatCategoryId: true },
      });
      const categoryBySeat = new Map(seats.map((s) => [s.id, s.seatCategoryId]));
      if (seats.length !== new Set(allSeatIds).size) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'One or more selected seats are invalid.',
          HttpStatus.BAD_REQUEST,
        );
      }
      for (const item of reservedItems) {
        const tt = byId.get(item.ticketTypeId)!;
        for (const seatId of item.seatIds!) {
          if (categoryBySeat.get(seatId) !== tt.seatCategoryId) {
            throw new AppException(
              ErrorCodes.VALIDATION_FAILED,
              'A selected seat does not match its price category.',
              HttpStatus.BAD_REQUEST,
              { seatId },
            );
          }
        }
      }
    }

    // Line pricing via the experience's pricing strategy (TIER for events, SEAT for
    // movies). Base prices equal the ticket-type face price, so the subtotal is
    // identical to the platform's original pricing. See ADR-019.
    const priceQuote = this.pricingStrategies.quote({
      experienceType: session.event.experienceType,
      seatBased: isSeatBased,
      sessionStartsAt: session.startsAt,
      now,
      lines: input.items.map((i) => {
        const tt = byId.get(i.ticketTypeId)!;
        return {
          ticketTypeId: i.ticketTypeId,
          quantity: i.quantity,
          basePriceMinor: tt.priceMinor,
          seatCategoryId: tt.seatCategoryId,
        };
      }),
    });
    // Experience Commerce (v1.3): resolve add-on + bundle lines and fold their
    // totals into the subtotal so the existing fee/coupon math applies unchanged.
    const commerce = await this.resolveCommerceLines(session, input, now, isSeatBased);
    const subtotal = priceQuote.subtotalMinor + commerce.subtotalMinor;

    const feeMode = session.event.feeMode as FeeMode;
    // Settled before the coupon: a fixed-amount code applies only to bookings in its currency.
    const currency = this.cartCurrency(
      input.items.map((i) => byId.get(i.ticketTypeId)!),
      session.event.venue?.country,
    );
    const { discountMinor, couponId } = await this.resolveCoupon(
      input.couponCode,
      subtotal,
      session.event.organizationId,
      currency,
    );
    // Where this sale happens, for tax. The same function the quote uses, so the two cannot
    // disagree about the place of supply or the buyer's state - see `saleTaxPlace`.
    const taxPlace = saleTaxPlace(session.event, input.buyerRegion, now);
    /*
      ── REGULATORY PRICING, FOR CINEMA SESSIONS ──────────────────────────────────────
      Resolved ONCE here and passed down, rather than looked up inside the pricing service:
      resolution needs the cinema's classification, and the pricing service prices carts, not
      venues. `now` is the same instant the tax place already uses, so a policy that changes
      at midnight cannot be straddled by one checkout.

      A session with no cinema resolves NOT_REGULATED and every number below is unchanged.
    */
    const admissionLines = this.admissionLinesFor(session.event, input.items, byId);
    const policy = await this.resolveCinemaPolicy(session, currency, admissionLines, now);

    /*
      ── CAN THIS CART BE SOLD ONLINE ─────────────────────────────────────────────────
      Fail closed. A market declared regulated whose rule cannot be resolved must not fall
      through to the platform's ordinary fee schedule - that is the silent non-compliance
      this whole subsystem exists to prevent, and it would look exactly like a normal sale.
      And a ticket priced above the maximum its seat class permits is refused: the SALE, not
      the configuration, so nobody takes money for it.

      REQUIRES_APPROVAL is deliberately NOT a refusal: it is a resolved policy whose fee
      position is unconfirmed, so the fee is suppressed to zero and the ticket still sells.

      ── WHY THE DECISION IS NOT WRITTEN OUT HERE ANY MORE ─────────────────────────────
      It was two `if`s in this method, and nothing else in the platform could ask them. The
      cinema readiness page therefore said "Ready to open" for a cinema whose every sale this
      method refused, and the storefront let buyers pick seats for a show nobody could buy.
      `saleBlockersFromPolicy` is those same two refusals, in the same order, and it is what
      readiness and the public show endpoint ask too - so the three cannot disagree.

      The buyer is told the show is not open for online booking. Not why: the reason is about
      our configuration and a state's rate order, and they can do nothing with it. The full
      explanation goes to the audit, where the person who can act on it will read it.
    */
    /*
      The pilot's limits that do not need the total, BEFORE the cinema-policy refusal: a cinema
      show in pilot mode is refused as the quote refused it, PILOT_RESERVED_SEATING, rather than
      with whatever the policy says. "Charged" is read from the subtotal after discount, which
      is zero exactly when the total is. The order cap waits for the total, below.
    */
    if (this.pilot?.active()) {
      this.pilot.assertSale(
        this.pilotSale(
          session,
          currency,
          Math.max(0, subtotal - discountMinor),
          input.paymentMethod === 'CASH',
          [input.buyerEmail, ...(user ? [user.email] : [])],
        ),
        'beforePrice',
      );
    }
    const blockers = saleBlockersFromPolicy(policy, {
      cinemaId: session.screen?.cinema?.id ?? null,
      ticketTypeIds: input.items.map((i) => i.ticketTypeId),
    });
    if (blockers.length > 0) {
      await this.audit.record({
        organizationId: session.event.organizationId,
        action: 'CINEMA_PRICING_POLICY_BLOCKED_BOOKING',
        entityType: 'EventSession',
        entityId: session.id,
        metadata: {
          ...(this.policyService?.auditFor(policy.resolution, policy.context) ?? {}),
          ...(policy.overCeiling.length > 0 ? { overCeiling: policy.overCeiling } : {}),
          blockers: blockers.map((b) => b.code),
        },
      });
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        BUYER_SALE_NOT_OPEN,
        HttpStatus.CONFLICT,
        {
          reason: SALE_NOT_OPEN_REASON,
          blockers: blockers.map((b) => b.code),
        },
      );
    }

    const fees = await this.pricing.quote(
      subtotal,
      feeMode,
      discountMinor,
      currency,
      taxPlace,
      /*
        Rated by the TAX classification, not by the seat class the cinema policy above uses.
        The two used to be one field, so the tax rules (written for 'MOVIE') were handed
        REGULAR or RECLINER and never matched - see `taxAdmissionLines`.
      */
      taxAdmissionLines(admissionLines),
      policy.effect,
    );

    /*
      ── THE PILOT'S LIMITS ───────────────────────────────────────────────────────────
      After the price, because two of them are about the total. The daily cap is checked again
      inside the transaction below, under the pilot lock, which is what makes it hold for two
      buyers at once; this first pass refuses everything else before any stock is touched.
    */
    if (this.pilot?.active()) {
      this.pilot.assertSale(
        this.pilotSale(session, currency, fees.totalMinor, input.paymentMethod === 'CASH', [
          input.buyerEmail,
          ...(user ? [user.email] : []),
        ]),
      );
    }

    /*
      A free event is free all the way down.

      The fee calculator already returns zero for a zero subtotal, so this is not arithmetic
      — it is a guard. An event DECLARED free whose tickets carry a price is a data error,
      and the failure mode without this check is the worst kind: the booking would take the
      free path, skip the payment provider, and hand out tickets somebody owed money for.
      Refusing loudly is the only safe answer, and the organizer sees why.
    */
    const isFree = session.event.isFree;
    if (isFree && (subtotal !== 0 || fees.totalMinor !== 0)) {
      await this.audit.record({
        organizationId: session.event.organizationId,
        action: 'FREE_EVENT_PRICED_BOOKING_REFUSED',
        entityType: 'Event',
        entityId: session.eventId,
        metadata: { subtotalMinor: subtotal, totalMinor: fees.totalMinor },
      });
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'This event is marked free but its tickets carry a price. Set every ticket type to zero, or turn off the free-event setting.',
        HttpStatus.CONFLICT,
        { subtotalMinor: subtotal, totalMinor: fees.totalMinor },
      );
    }

    /*
      Paying in cash at the venue, which the ORGANIZER must have turned on.

      Checked against the organization rather than trusted from the request, for the same
      reason the payment provider is never taken from the client: otherwise anybody could
      reserve seats for nothing by asking nicely. A client that sends CASH to an organizer
      who has not enabled it is refused and told why.
    */
    const wantsCash = input.paymentMethod === 'CASH';
    if (wantsCash && isFree) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'This event is free. There is nothing to collect.',
        HttpStatus.CONFLICT,
      );
    }
    /*
      The switch is about buyers ONLINE reserving now and paying at the venue later - what the
      storefront offers. A counter sale is not that: the organizer's own staff take the money
      in hand and the ticket is issued at once, so it does not wait on the switch. Turning
      reservations on just to sell at the door would also have offered "pay at the venue" to
      every online buyer, which an organizer may not want.
    */
    if (wantsCash && !opts?.counterSale && !session.event.organization.cashPaymentsEnabled) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'This organizer does not accept cash at the venue.',
        HttpStatus.CONFLICT,
      );
    }

    /*
      A cash reservation is held until the show starts, not for the usual few minutes.

      The whole point is that somebody pays when they arrive, so a fifteen-minute hold would
      expire before they had left the house. The cost is real and deliberate: those seats are
      off sale until showtime even if nobody turns up, which is exactly what a counter-run
      cinema already does with a telephone booking — and why the organizer can cancel one
      from the console to put the seats back.
    */
    // A counter sale is collected the moment it is made, so it holds only as long as any sale.
    const holdExpiresAt =
      wantsCash && !opts?.counterSale
        ? session.startsAt
        : new Date(now.getTime() + this.holdMinutes * 60 * 1000);

    /*
      The whole order's size, bundle tickets included, against the online ceilings: one order,
      and one pay-at-venue reservation, which holds its seats until showtime and so is smaller.
      Counter sales are not limited. Read from the same configuration the hold limits use.
    */
    assertOrderSize(
      input.items.reduce((sum, i) => sum + i.quantity, 0) +
        commerce.ticketHolds.reduce((sum, h) => sum + h.quantity, 0),
      this.holdLimits?.limits() ?? holdLimitsFrom(this.config),
      { counterSale: opts?.counterSale, wantsCash },
    );

    // The inventory model is chosen by the experience type — general admission
    // for events today, seat-based for movies in a later PR — without this
    // engine changing. See ADR-010.
    const strategy = this.inventory.forSeating(isSeatBased);

    const ticketLines: InventoryLine[] = input.items.map((i) => ({
      ticketTypeId: i.ticketTypeId,
      quantity: i.quantity,
      seatIds: i.seatIds,
    }));

    const held = this.prisma.$transaction(async (tx) => {
      // The pilot's daily cap, serialized: see `PilotGuardService.reserveDailyCapacity`. A
      // refusal here rolls back before the booking row or any hold exists.
      if (this.pilot?.active()) {
        await this.pilot.reserveDailyCapacity(tx, { currency, totalMinor: fees.totalMinor });
      }
      /*
        Claim the idempotency key FIRST, before anything is held. A concurrent request with the
        same key blocks here on the unique index until this transaction ends, then fails with a
        unique violation and reads this one's answer (the catch below) - it never builds a second
        booking, and never reaches the `Booking.idempotencyKey` constraint as a 500.
      */
      if (idem) {
        await tx.idempotencyRecord.create({
          data: {
            scope: idem.scope,
            key: idem.key,
            requestHash: idem.requestHash,
            status: 'IN_PROGRESS',
          },
        });
      }
      /*
        The active-hold limits, counted and enforced under a per-buyer lock in THIS transaction,
        so two requests at once cannot both pass and a refusal leaves nothing behind. Not for a
        counter sale: that is the organizer's staff selling in person, collected at once.
      */
      const holdReceipt =
        this.holdLimits && !opts?.counterSale
          ? await this.holdLimits.enforce(tx, {
              userId: user?.id ?? null,
              buyerEmail: input.buyerEmail,
              clientIp: opts?.clientIp ?? null,
              eventSessionId: session.id,
              wantsCash,
              now,
            })
          : null;
      // Create the pending booking first so the strategy can bind held seats to
      // it, then perform the atomic, oversell-/double-book-proof hold. If the
      // hold fails the whole transaction (booking + items + payment) rolls back.
      const created = await tx.booking.create({
        data: {
          organizationId: session.event.organizationId,
          eventId: session.eventId,
          eventSessionId: session.id,
          userId: user?.id ?? null,
          couponId,
          buyerName: input.buyerName,
          buyerEmail: input.buyerEmail,
          // Stored, not re-derived later: a GST invoice states the place of supply, and a
          // registration or a rate can change after the sale. See the schema comment.
          customerRegion: input.buyerRegion?.trim() || null,

          /*
            ── THE IMMUTABLE PRICING SNAPSHOT ─────────────────────────────────────────
            Denormalised on purpose. The relation to the policy row lets an auditor read it
            as it is NOW; these columns are what the order actually MEANT, and they stay true
            after the policy is superseded, corrected or withdrawn.

            Without them, a later correction to a government-order row would silently rewrite
            the financial interpretation of every booking ever priced under it — including
            invoices already in customers' hands.
          */
          maintenanceMinor: fees.maintenanceMinor ?? 0,
          maintenanceTreatment: fees.maintenanceTreatment ?? 'NOT_APPLICABLE',
          pricingPolicyId: policy.resolution.policy?.id ?? null,
          pricingPolicyVersion: policy.resolution.policy?.version ?? null,
          pricingPolicyEffective: policy.resolution.policy?.effectiveFrom ?? null,
          regulatoryReference: policy.resolution.policy?.regulatoryReference ?? null,
          // Why it applied, not just which one did. A cinema can be reclassified tomorrow.
          pricingJurisdiction: {
            country: policy.context.country,
            region: policy.context.region,
            district: policy.context.district,
            city: policy.context.city,
            localBodyType: policy.context.localBodyType,
            cinemaFormat: policy.context.cinemaFormat,
            climateType: policy.context.climateType,
            matchedOn: policy.resolution.explanation,
          },
          complianceStatus: policy.resolution.status,
          status: BookingStatus.PENDING_PAYMENT,
          // Settled here so confirmation and refund reach for the same strategy this hold
          // used, whatever happens to the session afterwards.
          seatBased: isSeatBased,
          feeMode,
          // Snapshotted with the money, like every other amount on this row. The column
          // defaulted to INR and was never written, so a dollar-priced booking claimed to
          // be in rupees — and every screen, receipt and refund believed it.
          currency,
          subtotalMinor: subtotal,
          bookingFeeMinor: fees.bookingFeeMinor,
          paymentFeeMinor: fees.paymentFeeMinor,
          discountMinor: fees.discountMinor,
          customerFeeMinor: fees.customerFeeMinor,
          organizerFeeMinor: fees.organizerFeeMinor,
          // Snapshotted, like every other money field on this row: the rule that produced
          // each line may be deactivated or superseded later, and a receipt reprinted next
          // year must show what this customer was charged today.
          taxMinor: fees.taxMinor,
          taxLines: {
            create: fees.taxLines.map((t) => ({
              label: t.label,
              rateBasisPoints: t.rateBasisPoints,
              baseMinor: t.baseMinor,
              amountMinor: t.amountMinor,
              /*
                Stored, at last. The calculator has always stated both; discarding them left
                every reader of a booking guessing which lines were the fee's and which were
                already inside the price — and the checkout guessed wrong in both directions
                at once.
              */
              basis: t.basis,
              inclusive: t.inclusive,
            })),
          },
          totalMinor: fees.totalMinor,
          holdExpiresAt,
          // The actor-scoped key, not the raw header: two buyers who send the same header are
          // two different requests and must not collide on this unique column.
          idempotencyKey: idem?.key ?? null,
          items: {
            create: [
              ...priceQuote.lines.map((pl) => ({
                kind: BookingItemKind.TICKET,
                ticketTypeId: pl.ticketTypeId,
                quantity: pl.quantity,
                unitPriceMinor: pl.unitPriceMinor,
                lineTotalMinor: pl.lineTotalMinor,
                // What this line was taxed as, so a re-price rates the same thing.
                taxCategory: ticketTaxCategory(byId.get(pl.ticketTypeId), session.event),
              })),
              ...commerce.itemCreates,
            ],
          },
          /*
            No Payment row at all when there is nothing to pay.

            Not a zero-amount one: it would appear in every reconciliation, settlement and
            payout report as a line that can never balance against a bank statement, because
            no bank was involved.
          */
          paymentMethod: wantsCash ? 'CASH' : 'ONLINE',
          /*
            Cash creates no Payment row either, and for the reason written above rather than
            a new one: no bank is involved. Settlement reads Payment rows, so this is also
            what stops the platform ever promising an organizer money it never received.
          */
          ...(isFree || wantsCash
            ? {}
            : {
                payment: {
                  create: {
                    provider: 'mock',
                    status: PaymentStatus.REQUIRES_PAYMENT,
                    amountMinor: fees.totalMinor,
                    /*
                      The booking's currency, stated. Left out, the column default wrote "INR"
                      on every payment — found on QA as twelve payments for US-dollar bookings
                      recorded in rupees, shown with ₹ on the admin payments page and set to
                      read as a currency mismatch against the provider in reconciliation.
                    */
                    currency,
                  },
                },
              }),
        },
        include: { items: true, payment: true },
      });

      // Hold ticket stock (direct ticket lines + any bundle ticket components) and
      // add-on stock in the same transaction; a failure rolls the whole order back.
      await strategy.reserve(tx, {
        eventSessionId: session.id,
        bookingId: created.id,
        holdExpiresAt,
        lines: [...ticketLines, ...commerce.ticketHolds],
      });
      if (commerce.addOnHolds.length > 0) {
        await this.addOnInventory.reserve(tx, commerce.addOnHolds);
      }
      // In-transaction hook (ADR-042 P5.3A.1): ALLOCATED bookings run the atomic allocation
      // capacity guard + held-consumption event here, so a guard failure rolls the whole hold
      // back (oversell-proof) and the allocation ledger commits atomically with the booking.
      if (hooks?.inHoldTx) await hooks.inHoldTx(tx, created.id);
      if (holdReceipt) await holdReceipt.record(created.id, holdExpiresAt);
      return created;
    });
    const outcome = await held.then(
      (created) => ({ created }),
      async (err: unknown) => {
        // Another request with this key got there first: answer with its booking.
        if (idem && isUniqueViolation(err)) {
          const earlier = await this.replayFor(idem, { afterConflict: true });
          if (earlier) return { replay: earlier };
        }
        throw err;
      },
    );
    if ('replay' in outcome) return outcome.replay;
    const booking = outcome.created;

    await this.audit.record({
      actorUserId: user?.id ?? null,
      organizationId: session.event.organizationId,
      action: 'BOOKING_CREATED',
      entityType: 'Booking',
      entityId: booking.id,
      metadata: { totalMinor: booking.totalMinor },
    });
    this.metrics.recordBookingCreated();

    // Shadow-mode distributed lock observation (ADR-039). PostgreSQL already holds
    // authoritatively above; this only MEASURES what the Redis lock layer would have
    // decided and never changes the outcome. Fully isolated + no-op when disabled.
    try {
      const seatIds = input.items.flatMap((i) => i.seatIds ?? []);
      const quantity = input.items.reduce((s, i) => s + i.quantity, 0);
      await this.lockShadow.observe({
        inventoryType: isSeatBased ? 'SEAT' : 'QUANTITY',
        inventoryKey: `session:${session.id}`,
        seatIds: isSeatBased ? seatIds : undefined,
        quantity: isSeatBased ? undefined : quantity,
        capacity: quantity,
        holdId: booking.id,
        bookingId: booking.id,
        owner: user?.id ? { ownerId: user.id } : { anonymousSessionId: booking.id },
      });
    } catch {
      /* shadow observation must never affect booking creation */
    }

    // Booking-orchestration shadow observation (ADR-042). Observes what the orchestrator
    // would decide (provider resolution + workflow expectation) alongside this legacy
    // hold. Fully isolated + no-op unless BOOKING_ORCHESTRATOR_ENABLED + mode=shadow.
    try {
      await this.bookingShadow.observe({
        bookingId: booking.id,
        eventSessionId: session.id,
        experienceType: session.event.experienceType,
        seatCount: input.items.flatMap((i) => i.seatIds ?? []).length,
        quantity: input.items.reduce((s, i) => s + i.quantity, 0),
      });
    } catch {
      /* shadow observation must never affect booking creation */
    }

    /*
      A free booking is finished the moment it is held.

      There is no provider to redirect to and no webhook that will ever arrive, so leaving it
      PENDING_PAYMENT would mean the hold quietly expires and the customer never gets the
      ticket they were told was free. Confirming here runs the SAME path a paid booking runs
      after its webhook — tickets, QR codes, notifications, the confirmation email — so
      everything downstream of the money is identical. Only the money is absent.

      Deliberately not swallowed: if confirmation fails the caller sees the failure and the
      held booking expires on its own, which is recoverable. Returning a "free booking" that
      is silently still pending is not.
    */
    let freeStatus: BookingStatus | undefined;
    if (isFree) {
      try {
        if (!this.payments) {
          throw new AppException(
            ErrorCodes.INTERNAL,
            'Free bookings are not available in this configuration.',
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }
        const outcome = await this.payments.confirmFreeBooking(booking.id);
        if (outcome.status === 'confirmed' || outcome.status === 'already_confirmed') {
          freeStatus = BookingStatus.CONFIRMED;
        }
      } catch (err) {
        /*
          The booking exists and its hold will expire on its own, but its key will never be
          completed. Released, so a retry with the same key starts afresh - what a retry did
          before keys were claimed - instead of waiting on a record that cannot finish.
        */
        if (idem) await this.releaseIdempotencyKey(idem, booking.id);
        throw err;
      }
    }

    const result = {
      id: booking.id,
      status: freeStatus ?? booking.status,
      currency: booking.currency,
      holdExpiresAt: booking.holdExpiresAt,
      fees,
      paymentMethod: wantsCash ? 'CASH' : 'ONLINE',
      // A free or cash booking has no Payment row, and says so rather than reporting an
      // empty one — a client that saw `payment: {}` would send the buyer to a checkout.
      payment:
        isFree || wantsCash ? null : { id: booking.payment?.id, status: booking.payment?.status },
    };

    if (idem) {
      await this.prisma.idempotencyRecord
        .update({
          where: { scope_key: { scope: idem.scope, key: idem.key } },
          data: { status: 'COMPLETED', responseJson: result as unknown as Prisma.InputJsonValue },
        })
        .catch(() => undefined);
    }

    return result;
  }

  /**
   * The answer an earlier request with this key produced, or null when the key is new.
   *
   * A key used for a DIFFERENT body is refused rather than answered: replaying a booking that
   * does not match what was sent would be a wrong answer dressed as an idempotent one. A key
   * still being worked on is waited for, briefly - the first request is usually a second or two
   * from done - and then answered with a plain "still being created" rather than a 500.
   *
   * `afterConflict` is the path from a unique violation: the record existed when the insert
   * failed, so finding nothing now means the first request failed and released it. The caller
   * is told to try again rather than racing a second time inside this request.
   */
  private async replayFor(
    idem: BookingIdempotency,
    opts: { afterConflict?: boolean } = {},
  ): Promise<Prisma.JsonObject | null> {
    const deadline = Date.now() + IDEMPOTENCY_WAIT_MS;
    for (;;) {
      const record = await this.prisma.idempotencyRecord.findUnique({
        where: { scope_key: { scope: idem.scope, key: idem.key } },
      });
      if (!record) {
        if (!opts.afterConflict) return null;
        throw new AppException(ErrorCodes.CONFLICT, IDEMPOTENCY_IN_PROGRESS, HttpStatus.CONFLICT);
      }
      if (record.requestHash !== idem.requestHash) {
        throw new AppException(ErrorCodes.CONFLICT, IDEMPOTENCY_KEY_REUSED, HttpStatus.CONFLICT);
      }
      if (record.status === 'COMPLETED' && record.responseJson) {
        return record.responseJson as Prisma.JsonObject;
      }
      if (Date.now() >= deadline) {
        throw new AppException(ErrorCodes.CONFLICT, IDEMPOTENCY_IN_PROGRESS, HttpStatus.CONFLICT);
      }
      await new Promise((resolve) => setTimeout(resolve, IDEMPOTENCY_POLL_MS));
    }
  }

  /** Free a key whose booking failed after it was held, so a retry can begin again. */
  private async releaseIdempotencyKey(idem: BookingIdempotency, bookingId: string) {
    await this.prisma
      .$transaction(async (tx) => {
        await tx.idempotencyRecord.deleteMany({ where: { scope: idem.scope, key: idem.key } });
        await tx.booking.updateMany({
          where: { id: bookingId, idempotencyKey: idem.key },
          data: { idempotencyKey: null },
        });
      })
      .catch(() => undefined);
  }

  /**
   * Price a cart without creating anything.
   *
   * ── WHY THIS EXISTS SEPARATELY FROM create() ───────────────────────────────────────
   * Reported from QA: the seat screen showed a ticket subtotal and the words "transparent
   * fees shown on the next step", so the number a buyer actually pays first appeared one
   * screen after they had committed to seats. Showing it earlier needs the fee arithmetic
   * before a booking exists.
   *
   * Deliberately inert: this holds no seats, writes no rows, redeems no coupon and creates
   * no payment. It reads the same ticket types and commerce lines `create()` reads, and runs
   * the same pricing, so a quote and the booking that follows cannot disagree about money.
   *
   * It also does NOT check availability. A quote is about price; whether the seats are still
   * free is settled atomically at booking time, and answering it here would be a promise this
   * method cannot keep for the seconds between the two calls.
   */
  /**
   * Offers a buyer may be SHOWN for this session.
   *
   * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────
   * Every other active code. Listing them all would publish offers that were never meant to
   * be public — a win-back rate mailed to lapsed customers, a partner's code, an
   * influencer's. Those are worth exactly their scarcity, and leaking them is silent and
   * irreversible.
   *
   * So this returns only codes an organizer deliberately published, and private codes keep
   * working by being typed, which is what they are for.
   *
   * Scoped to the selling organization plus platform-wide offers: one organizer's promotion
   * must not advertise itself on another's checkout.
   */
  async publicOffers(eventSessionId: string) {
    if (this.couponsDisabled()) return [];
    const session = await this.prisma.eventSession.findUnique({
      where: { id: eventSessionId },
      select: { event: { select: { organizationId: true } } },
    });
    if (!session) return [];

    const now = new Date();
    const rows = await this.prisma.coupon.findMany({
      where: {
        isPublic: true,
        status: 'ACTIVE',
        OR: [{ organizationId: session.event.organizationId }, { organizationId: null }],
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return (
      rows
        // An exhausted code is not an offer. Showing one that cannot be redeemed is a worse
        // experience than showing nothing.
        .filter((c) => c.maxRedemptions === null || c.redemptions < c.maxRedemptions)
        .map((c) => ({
          code: c.code,
          label:
            c.publicLabel?.trim() ||
            (c.type === 'PERCENT' ? `${c.value}% off` : `${c.value / 100} off`),
        }))
    );
  }

  /**
   * The currency this cart is priced in, taken from what is actually being sold.
   *
   * ── WHY THIS IS DERIVED AND NOT A CONSTANT ─────────────────────────────────────────
   * Both the booking row and the fee calculation used the literal `'INR'`. That is not a
   * display detail: the currency picks the fee tiers, the tax rules and — via
   * `routeProviderForBooking` — which payment provider takes the money. A show priced in
   * dollars would have had rupee fee bands applied and been sent to an Indian gateway.
   *
   * The ticket types are the authority because the organizer set those prices. The venue's
   * country decides what a NEW ticket type is created in; once created, the stored price
   * is the fact, and re-deriving it here from the venue would let a venue edit silently
   * re-denominate tickets that are already on sale.
   *
   * ── WHY A MIXED CART IS REFUSED RATHER THAN RECONCILED ─────────────────────────────
   * There is one `totalMinor` and one charge. Two currencies in a cart cannot be added up
   * without an exchange rate, and this platform has no rate source — so the only honest
   * answers are "refuse" and "invent a number". Silently taking the first line's currency
   * would charge somebody dollars for a rupee ticket at a 1:1 rate, which is the kind of
   * error that is discovered on a bank statement.
   */
  /**
   * The order as the tax engine needs to see it: one entry per ticket kind, priced per unit.
   *
   * ── WHY NOT JUST THE SUBTOTAL ──────────────────────────────────────────────────────
   * India bands its rate on the price of ONE ticket — cinema at ₹100, recognised sport at
   * ₹500. Ten ₹90 seats are ten ₹90 seats; handing the engine a ₹900 total would put every
   * one of them in the higher band and overcharge the lot. The engine refuses a banded rule
   * without this, which is why it is built here rather than left optional in practice.
   *
   * The category is what the rate bands on. A MOVIE experience is cinema whatever the
   * organizer called it; everything else carries the event's own category, so an owner can
   * write a rule for `Sports` without the platform deciding what a sport is.
   */
  /**
   * Resolve the cinema pricing policy for one order, once.
   *
   * ── WHY IT RETURNS THE CONTEXT TOO ─────────────────────────────────────────────────
   * The booking snapshot records not only WHICH policy applied but WHY — the jurisdiction
   * and classification it matched on. Re-deriving that later from a cinema that may since
   * have been reclassified would answer a different question from the one an auditor asked.
   *
   * ── WHY A SESSION WITHOUT A CINEMA IS NOT AN ERROR ────────────────────────────────
   * It is every concert, every conference and every general-admission event on the platform.
   * They resolve NOT_REGULATED, which leaves fees, tax and totals exactly as they were before
   * this subsystem existed.
   */
  private async resolveCinemaPolicy(
    session: {
      screen?: {
        /*
          Optional because a space is no longer required to be a cinema screen. Only a cinema
          carries a regulatory classification, so a space without one resolves to no policy -
          which is correct: the orders this engine applies govern cinemas.
        */
        cinema?: PolicyCinema | null;
      } | null;
    },
    currency: string,
    admissionLines: AdmissionLine[],
    at: Date,
  ): Promise<CinemaPolicyOutcome> {
    /*
      The lookup itself lives in `sale-eligibility.ts` now, unchanged, so that the organizer's
      readiness page and the storefront ask the question this booking asks rather than a copy
      of it. Logging stays here: it is the record of a SALE meeting the engine, and a readiness
      check is not one.
    */
    const outcome = await resolveCinemaPolicy(
      this.policyService ? (ctx) => this.policyService!.resolve(ctx) : null,
      session.screen?.cinema ?? null,
      currency,
      admissionLines,
      at,
    );
    this.policyService?.logResolution(outcome.resolution, outcome.context);
    return outcome;
  }

  /**
   * The admission lines a pricing policy is resolved against.
   *
   * ── WHAT `category` USED TO BE, AND WHY IT WAS WRONG ───────────────────────────────
   * It was the EVENT's category — literally the string "MOVIE" for every cinema ticket. That
   * value was then handed to the policy resolver as the cart's seat class. No rate row names
   * a class called "MOVIE", so no ceiling row could ever match a real booking: every sale
   * fell through to the class-agnostic fallback, which carries maintenance and no maximum
   * price. The ₹150 and ₹250 ceilings were visible in the compliance screen and enforced on
   * precisely nothing.
   *
   * The seat class now comes from the ticket type's seat category, and it is the operator's
   * explicit `regulatoryClass` — not the category's display name, which an operator is free
   * to call "Gold".
   */
  private admissionLinesFor(
    event: { experienceType: string; category?: string | null; taxCategory?: string | null },
    items: { ticketTypeId: string; quantity: number }[],
    byId: Map<
      string,
      {
        name?: string;
        priceMinor: number;
        taxCategory?: string | null;
        seatCategory?: { name: string; regulatoryClass: string | null } | null;
      }
    >,
  ): {
    unitPriceMinor: number;
    quantity: number;
    ticketTypeId: string;
    /** What the ticket is called, so a price refusal can name the thing to re-price. */
    ticketTypeName: string | null;
    /** The mapped regulatory class, or null when the operator has not mapped this category. */
    category: string | null;
    /** What the operator calls it — for the refusal message, never for matching. */
    seatCategoryName: string | null;
    /**
     * What the ticket is FOR TAX: the ticket type's override, else the event's. Deliberately a
     * separate field from `category`: the seat class prices a cinema seat under a state rate
     * order and says nothing about which GST rate applies.
     */
    taxCategory: string | null;
  }[] {
    return items
      .map((i) => {
        const tt = byId.get(i.ticketTypeId);
        return {
          unitPriceMinor: tt?.priceMinor ?? 0,
          quantity: i.quantity,
          ticketTypeId: i.ticketTypeId,
          ticketTypeName: tt?.name ?? null,
          category: tt?.seatCategory?.regulatoryClass ?? null,
          seatCategoryName: tt?.seatCategory?.name ?? null,
          taxCategory: ticketTaxCategory(tt, event),
        };
      })
      .filter((line) => line.quantity > 0);
  }

  private cartCurrency(
    priced: { currency?: string | null }[],
    venueCountry: string | null | undefined,
  ): string {
    /*
      A line with no currency contributes no opinion rather than crashing the booking: a
      missing one means a `select` that did not ask for the column, and the venue answers
      instead. The rule itself is shared with add-ons and bundles, so the things sold beside
      a ticket cannot be priced in a different currency from it.
    */
    return resolveCommerceCurrency(
      priced.map((p) => p?.currency),
      venueCountry,
    );
  }

  async quote(input: QuoteBookingInput) {
    const session = await this.prisma.eventSession.findUnique({
      where: { id: input.eventSessionId },
      include: {
        event: {
          include: {
            venue: { select: { country: true, region: true, city: true } },
            organization: {
              select: {
                registeredCountry: true,
                registeredRegion: true,
                // Whether this organizer takes cash at the venue. Read from the org, never
                // trusted from the request — otherwise anybody could reserve seats for free.
                cashPaymentsEnabled: true,
                status: true,
                name: true,
              },
            },
          },
        },
        // The same cinema the create path loads, so a quote and the booking that follows it
        // resolve the identical policy. See the note there.
        screen: {
          select: {
            cinema: {
              select: {
                id: true,
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
      },
    });
    if (!session) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Session not found.', HttpStatus.NOT_FOUND);
    }
    /*
      The same two refusals `create` makes.

      A quote is a price shown to somebody about to pay. Quoting for a suspended organizer would
      put a total on the screen that the very next request refuses - the customer would read the
      refusal as the platform failing at the last step, rather than as an organizer who is not
      selling. Both paths read the same guard so they cannot drift apart.
    */
    this.assertOrganizerSelling(session.event.organization);
    this.assertSessionNotStarted(session.startsAt);

    const ticketTypes = await this.prisma.ticketType.findMany({
      where: {
        id: { in: input.items.map((i) => i.ticketTypeId) },
        eventSessionId: input.eventSessionId,
      },
      // Same include as the booking path: a quote that resolved a different policy from the
      // booking would show the customer a price they are not then charged.
      include: { seatCategory: { select: { name: true, regulatoryClass: true } } },
    });
    const byId = new Map(ticketTypes.map((t) => [t.id, t]));
    for (const item of input.items) {
      const tt = byId.get(item.ticketTypeId);
      if (!tt) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'One or more ticket types are invalid for this session.',
          HttpStatus.BAD_REQUEST,
        );
      }
      this.assertTicketTypeActive(tt);
    }

    // Follows the room, exactly as `create` does — a quote and the booking that follows it
    // must not disagree about whether the buyer is choosing seats.
    const isSeatBased = Boolean(session.screenId);

    const now = new Date();
    const priceQuote = this.pricingStrategies.quote({
      experienceType: session.event.experienceType,
      seatBased: isSeatBased,
      sessionStartsAt: session.startsAt,
      now,
      lines: input.items.map((i) => {
        const tt = byId.get(i.ticketTypeId)!;
        return {
          ticketTypeId: i.ticketTypeId,
          quantity: i.quantity,
          basePriceMinor: tt.priceMinor,
          seatCategoryId: tt.seatCategoryId,
        };
      }),
    });

    // Resolves add-on and bundle lines. Read-only — it returns the holds a booking WOULD
    // take rather than taking them.
    const commerce = await this.resolveCommerceLines(
      session,
      input as unknown as CreateBookingInput,
      now,
      isSeatBased,
    );
    const subtotal = priceQuote.subtotalMinor + commerce.subtotalMinor;

    // The same derivation `create` uses. A quote and the booking that follows it disagreeing
    // about the currency would be a price shown in one denomination and charged in another.
    // Settled before the coupon, which as a fixed amount applies only in its own currency.
    const currency = this.cartCurrency(
      input.items.map((i) => byId.get(i.ticketTypeId)!),
      session.event.venue?.country,
    );
    const { discountMinor, couponId } = await this.resolveCoupon(
      input.couponCode,
      subtotal,
      session.event.organizationId,
      currency,
    );
    /*
      The quote resolves the SAME policy the booking will, at the same instant, so the
      breakdown shown before a customer commits is the one they are charged. A quote that
      resolved separately could differ across a midnight policy change mid-checkout.
    */
    const quoteAdmissionLines = this.admissionLinesFor(session.event, input.items, byId);
    const quotePolicy = await this.resolveCinemaPolicy(session, currency, quoteAdmissionLines, now);

    const fees = await this.pricing.quote(
      subtotal,
      session.event.feeMode as FeeMode,
      discountMinor,
      currency,
      // The one derivation `create` uses: a quote and the booking that follows it must not
      // disagree about where the sale happens or where the buyer is.
      saleTaxPlace(session.event, input.buyerRegion, now),
      // The same tax lines `create` rates, so the quote and the booking cannot disagree.
      taxAdmissionLines(quoteAdmissionLines),
      quotePolicy.effect,
    );

    /*
      The pilot answers a quote as it will answer the booking: the same rules on the same
      total, the daily cap read without the lock (a quote holds nothing). Only the buyer
      allowlist waits for the booking, because a quote does not say who is buying.
    */
    if (this.pilot?.active()) {
      const pilotBlockers = await this.pilot.blockersFor(
        this.pilotSale(session, currency, fees.totalMinor, false, undefined),
        now,
      );
      if (pilotBlockers.length > 0) this.pilot.refuse(pilotBlockers);
    }

    return {
      fees,
      // Stated rather than inferred from a zero discount: "the code you typed was not
      // recognised" and "you typed no code" are different answers and the screen says which.
      coupon: input.couponCode
        ? { code: input.couponCode, applied: Boolean(couponId) }
        : { code: null, applied: false },
    };
  }

  /**
   * Apply or clear a discount code on a booking that has not been paid for yet.
   *
   * ── WHY THIS EXISTS AT CHECKOUT AND NOT ONLY AT BOOKING TIME ───────────────────────
   * A code could always be passed when the booking was CREATED, which is the moment the
   * buyer is picking seats — not the moment they are thinking about money. Reported from
   * QA: an organizer made a promotion and then found nowhere in the customer flow to use
   * it. A discount box belongs on the screen showing the total.
   *
   * ── WHAT MAKES THIS SAFE TO DO AFTER THE FACT ──────────────────────────────────────
   * Re-pricing a booking is only safe while nothing downstream has acted on the old price.
   * Two conditions are checked, and both are refusals rather than warnings:
   *
   *   - the booking is still PENDING_PAYMENT, so no ticket has been issued;
   *   - the payment has not been handed to a provider yet (no providerRef, still
   *     REQUIRES_PAYMENT). Once an intent exists at the gateway it holds an amount, and
   *     changing ours behind it is how a charge and a booking come to disagree.
   *
   * The Payment row is updated in the same transaction as the booking, because a total and
   * the amount to be charged that disagree is the one outcome worth crashing to avoid.
   */
  /**
   * Give the buyer more time on a hold they already have.
   *
   * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
   * The seats are held on a timer and there was no way to extend it. For most people that is
   * an inconvenience; for somebody reading with a screen reader, typing one-handed, or
   * translating the page as they go, a countdown they cannot stop is the difference between
   * being able to buy a ticket and not. WCAG 2.2.1 is a Level A criterion and this was a
   * plain failure of it.
   *
   * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────────────
   * It does not extend indefinitely, and it does not re-check availability. The seats are
   * already held by this booking — extending is a promise the platform has already made and
   * is simply keeping for longer. Re-running the availability check here would be able to
   * FAIL, which would take seats away from somebody who has done nothing wrong.
   *
   * The window is measured from NOW rather than added to what is left, so a buyer who asks
   * with nine minutes remaining does not accumulate nineteen. The purpose is "give me time to
   * finish", not "let me sit on this".
   */
  async extendHold(user: RequestUser | null, bookingId: string, access?: GuestMutationAccess) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        userId: true,
        status: true,
        holdExpiresAt: true,
        holdExtensions: true,
        organizationId: true,
        paymentMethod: true,
      },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }

    this.assertMayChangeUnpaid(user, booking, access, 'You cannot change this booking.');

    if (booking.status !== BookingStatus.PENDING_PAYMENT) {
      throw new AppException(
        ErrorCodes.BOOKING_NOT_PAYABLE,
        'This booking is not waiting for payment, so there is nothing to extend.',
        HttpStatus.CONFLICT,
      );
    }

    /*
      An expired hold is not extended back to life. The seats have already been returned to
      the pool by the sweeper, or are about to be, and handing them back here would be
      selling something that may now belong to somebody else.
    */
    if (booking.holdExpiresAt <= new Date()) {
      throw new AppException(
        ErrorCodes.BOOKING_EXPIRED,
        'This booking hold has already expired.',
        HttpStatus.CONFLICT,
      );
    }

    const max = this.maxHoldExtensions;

    /*
      A pay-at-the-venue reservation is already held until the show starts. "Extending" it
      would set a fresh ten-minute window measured from now — SHORTENING a hold meant to last
      until the doors open, so the reservation would lapse while the customer was on their
      way. Answered with the hold as it stands rather than refused: there is nothing wrong
      with asking, only nothing to give, and `extensionsRemaining: 0` stops the button.
    */
    if (booking.paymentMethod === 'CASH') {
      return {
        holdExpiresAt: booking.holdExpiresAt,
        holdExtensions: booking.holdExtensions,
        maxHoldExtensions: max,
        extensionsRemaining: 0,
      };
    }

    if (booking.holdExtensions >= max) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This hold has already been extended ${max} times. Complete the payment or start again.`,
        HttpStatus.CONFLICT,
        { holdExtensions: booking.holdExtensions, maxHoldExtensions: max },
      );
    }

    const holdExpiresAt = new Date(Date.now() + this.holdMinutes * 60 * 1000);
    /*
      The seats carry their own copy of the deadline, and it moves with the booking's.

      Only `Booking.holdExpiresAt` used to be extended. `ShowSeat.holdExpiresAt` kept the old
      expiry, and an operator blocking seats treats a HELD seat past its expiry as free — so
      it took seats this buyer was still paying for, and their payment then failed at seat
      confirmation. One transaction, so the two deadlines cannot disagree.
    */
    /*
      ── THE CAP IS ENFORCED BY THE UPDATE, NOT BY THE READ ABOVE ──────────────────────
      The count check above answers the ordinary case with a helpful message, but it ran
      outside any transaction, so ten requests sent at once all read "nine used" and all
      extended. The write is now conditional - still unpaid, still in time, and under the cap -
      so the database decides, one row at a time, and exactly `max` extensions can succeed
      however many arrive together. The loser is told the same thing the check would have said.
    */
    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.booking.updateMany({
        where: {
          id: bookingId,
          status: BookingStatus.PENDING_PAYMENT,
          paymentMethod: 'ONLINE',
          holdExpiresAt: { gt: new Date() },
          holdExtensions: { lt: max },
        },
        data: { holdExpiresAt, holdExtensions: { increment: 1 } },
      });
      if (claimed.count !== 1) return null;
      const row = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { holdExpiresAt: true, holdExtensions: true },
      });
      await tx.showSeat.updateMany({
        where: { holdBookingId: booking.id, status: 'HELD' },
        data: { holdExpiresAt },
      });
      return row;
    });
    if (!updated) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This hold has already been extended ${max} times, or is no longer waiting for payment. Complete the payment or start again.`,
        HttpStatus.CONFLICT,
        { maxHoldExtensions: max },
      );
    }

    return {
      holdExpiresAt: updated.holdExpiresAt,
      holdExtensions: updated.holdExtensions,
      maxHoldExtensions: max,
      /** What the UI needs in order to stop offering a button that will now be refused. */
      extensionsRemaining: Math.max(0, max - updated.holdExtensions),
    };
  }

  /**
   * Who may change an unpaid booking: its account, or - for a guest booking - the browser that
   * created it.
   *
   * ── THE HOLE THIS CLOSES ───────────────────────────────────────────────────────────
   * Both callers skipped the check whenever the booking had no account (`userId` null), on the
   * old reasoning that a guest booking is "reached by its unguessable id". Booking ids are not a
   * credential: they appear in URLs, in support threads and in screenshots. So any signed-in
   * account could extend somebody else's guest hold indefinitely or re-price it with a code.
   * A guest booking now needs its checkout session, verified by the router against the hash
   * stored on the booking, whoever is signed in. A booking that belongs to an account still
   * needs that account, and no longer accepts a caller with no account at all.
   */
  private assertMayChangeUnpaid(
    user: RequestUser | null,
    booking: { userId: string | null },
    access: GuestMutationAccess | undefined,
    message: string,
  ): void {
    if (booking.userId) {
      if (!user || booking.userId !== user.id) {
        throw new AppException(ErrorCodes.FORBIDDEN, message, HttpStatus.FORBIDDEN);
      }
      return;
    }
    if (!access?.guestSessionVerified) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'This booking was not started in this browser.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  async applyCoupon(
    user: RequestUser | null,
    bookingId: string,
    code: string | null,
    access?: GuestMutationAccess,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        payment: true,
        event: {
          select: {
            feeMode: true,
            // Needed to re-price WITH tax — see the quote call below for why its absence
            // was not merely incomplete but destructive.
            venue: { select: { country: true, region: true } },
            organization: { select: { registeredCountry: true, registeredRegion: true } },
            taxCategory: true,
          },
        },
        /*
          The tickets as they were priced, so the re-price rates them per ticket exactly as
          `create` did. See `admissionLinesFromItems`.
        */
        items: {
          where: { kind: BookingItemKind.TICKET },
          orderBy: { id: 'asc' },
          select: {
            unitPriceMinor: true,
            quantity: true,
            taxCategory: true,
            ticketType: { select: { taxCategory: true } },
          },
        },
      },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    this.assertMayChangeUnpaid(user, booking, access, 'Forbidden.');
    if (booking.status !== BookingStatus.PENDING_PAYMENT) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This booking can no longer be re-priced.',
        HttpStatus.CONFLICT,
      );
    }
    if (
      booking.payment &&
      (booking.payment.status !== PaymentStatus.REQUIRES_PAYMENT || booking.payment.providerRef)
    ) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'Payment has already started for this booking, so the price is fixed. Cancel and rebook to use a code.',
        HttpStatus.CONFLICT,
      );
    }

    const trimmed = code?.trim() ? code.trim() : undefined;
    const { discountMinor, couponId, refusal } = await this.resolveCoupon(
      trimmed,
      booking.subtotalMinor,
      booking.organizationId,
      booking.currency,
    );
    // An unrecognised code is told to the buyer rather than silently ignored: a discount box
    // that accepts anything and changes nothing is worse than one that says no.
    if (trimmed && !couponId) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        refusal ?? 'That code is not valid for this booking.',
        HttpStatus.BAD_REQUEST,
      );
    }

    /*
      Re-priced WITH the tax place, which this call was missing.

      It is not simply that the recomputed fees left tax out — the update below deletes
      every tax line and recreates them from this result. Applying a discount code would
      therefore have DELETED the tax on the booking and dropped the total by that amount,
      and the receipt would have shown a sale with no tax on it. Latent today because tax
      is off by default and there are no TaxRule rows, which is the only reason it has not
      been noticed; the first market that configures tax would have found it with money.

      The place comes from the same source `create` uses, so a re-price and the original
      pricing cannot disagree about where the sale happened.
    */
    /*
      ── RE-PRICING USES THE SNAPSHOT, NOT A FRESH RESOLUTION ─────────────────────────
      This runs when a coupon is applied to an EXISTING booking. Re-resolving would price it
      under whatever policy is active NOW — so applying a discount code the morning after a
      government order changed would silently restate the maintenance charge on a sale that
      had already happened, and the customer's receipt would stop matching their booking.

      The booking carries what it was priced under. That is what it stays priced under.
    */
    const snapshotEffect: PolicyEffect = {
      maintenanceMinor: booking.maintenanceMinor,
      maintenanceTreatment: booking.maintenanceTreatment,
      maintenanceAddedMinor:
        booking.maintenanceTreatment === 'ADDED_TO_TICKET_PRICE' ? booking.maintenanceMinor : 0,
      maintenanceTaxCategory: null,
      // The fee already charged is the ceiling: a coupon must not become an opportunity to
      // charge MORE fee than the original policy permitted.
      maxOnlineFeeMinor: booking.customerFeeMinor,
      complianceStatus: booking.complianceStatus,
      explanation: 'Re-priced under the policy snapshot recorded on this booking.',
    };

    const fees = await this.pricing.quote(
      booking.subtotalMinor,
      booking.feeMode as FeeMode,
      discountMinor,
      booking.currency,
      /*
        The buyer's state is read from the booking, not re-derived. This runs after the buyer
        has committed, and the place of supply that goes on their invoice is the one that
        applied when they bought - not whatever a later lookup would return.
      */
      saleTaxPlace(booking.event ?? {}, booking.customerRegion, new Date()),
      /*
        The SAME admission lines `create` priced, rebuilt from the booking's own ticket rows.

        This passed none, and a banded rule refuses an order it cannot rate per ticket - so
        with India GST active (its cinema and sport rates band on the ticket price), entering
        a code at checkout threw instead of re-pricing. Rebuilt from the stored unit prices,
        not today's ticket type, because the booking is what the buyer was quoted.
      */
      admissionLinesFromItems(booking.items ?? [], booking.event),
      snapshotEffect,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          couponId,
          discountMinor: fees.discountMinor,
          // Carried through unchanged. A coupon changes what is discounted, never what a
          // government order charges.
          maintenanceMinor: fees.maintenanceMinor ?? booking.maintenanceMinor,
          bookingFeeMinor: fees.bookingFeeMinor,
          paymentFeeMinor: fees.paymentFeeMinor,
          customerFeeMinor: fees.customerFeeMinor,
          organizerFeeMinor: fees.organizerFeeMinor,
          taxMinor: fees.taxMinor,
          totalMinor: fees.totalMinor,
          // Re-priced from scratch, so any previous tax lines are replaced rather than
          // added to — leaving stale ones would double-count on the receipt.
          taxLines: {
            deleteMany: {},
            create: fees.taxLines.map((t) => ({
              label: t.label,
              rateBasisPoints: t.rateBasisPoints,
              baseMinor: t.baseMinor,
              amountMinor: t.amountMinor,
              /*
                Stored, at last. The calculator has always stated both; discarding them left
                every reader of a booking guessing which lines were the fee's and which were
                already inside the price — and the checkout guessed wrong in both directions
                at once.
              */
              basis: t.basis,
              inclusive: t.inclusive,
            })),
          },
        },
      });
      await tx.payment.updateMany({
        where: { bookingId: booking.id },
        data: { amountMinor: fees.totalMinor },
      });
    });

    return { applied: Boolean(couponId), code: trimmed ?? null, fees };
  }

  /**
   * A discount code, if it is valid for a sale by `sellingOrganizationId`.
   *
   * ── WHY THE ORGANIZATION IS PART OF THE QUESTION ────────────────────────────────────
   * Codes are globally unique, and this looked one up by code alone. Any organizer could
   * therefore create a 100% code and spend it on ANOTHER organization's tickets — the
   * discount coming out of the other organizer's takings. A code now applies only to its own
   * organization's sales, or to any sale when it is platform-wide (no organization).
   *
   * An out-of-scope code is answered exactly like an unknown one, so the checkout cannot be
   * used to learn which other organizations' codes exist.
   *
   * The redemption cap is checked against the redemptions already counted. Those are only
   * counted at confirmation, so concurrent unpaid bookings can each pass this check; making
   * the cap exact is the confirmation path's job, not this lookup's.
   */
  /*
    The platform-wide switch for discount codes (COUPONS_ENABLED). Off, every code is refused
    with a plain reason and no discount is taken, the public offers list is empty, and
    organizers cannot create new codes. It exists because a code with a redemption cap can be
    over-redeemed when two checkouts race past the cap (the cap is checked at hold time and
    counted at confirmation); until that is reserved atomically, production keeps codes off.
  */
  private couponsDisabled(): boolean {
    return this.config?.get<string>('COUPONS_ENABLED') === 'false';
  }

  private async resolveCoupon(
    code: string | undefined,
    subtotal: number,
    sellingOrganizationId: string,
    currency: string,
  ): Promise<{ discountMinor: number; couponId: string | null; refusal?: string }> {
    if (!code) return { discountMinor: 0, couponId: null };
    if (this.couponsDisabled()) {
      return {
        discountMinor: 0,
        couponId: null,
        refusal: 'Discount codes are not available right now.',
      };
    }
    const coupon = await this.prisma.coupon.findUnique({ where: { code } });
    const now = new Date();
    const valid =
      coupon &&
      coupon.status === 'ACTIVE' &&
      (coupon.organizationId === null || coupon.organizationId === sellingOrganizationId) &&
      (!coupon.startsAt || coupon.startsAt <= now) &&
      (!coupon.endsAt || coupon.endsAt >= now) &&
      (coupon.maxRedemptions === null || coupon.redemptions < coupon.maxRedemptions);
    if (!valid) return { discountMinor: 0, couponId: null };

    /*
      ── A FIXED AMOUNT IS MONEY IN ONE CURRENCY ──────────────────────────────────────
      A FIXED `value` is minor units and was taken off whatever booking it met, so a ₹500-off
      code took $500 off a dollar booking. It now applies only to bookings in its own currency.
      A FIXED coupon with no currency predates the column and was written when rupees were all
      the platform sold, so it applies to INR alone.

      Refused with its own reason rather than as an unknown code. The scope check above has
      already established that the code is this organization's, so naming its currency tells the
      buyer nothing about anybody else — and saves them retyping a code that was never mistyped.
    */
    if (coupon.type === 'FIXED') {
      const couponCurrency = (coupon.currency ?? 'INR').toUpperCase();
      const bookingCurrency = currency.toUpperCase();
      if (couponCurrency !== bookingCurrency) {
        return {
          discountMinor: 0,
          couponId: null,
          refusal: `That code takes an amount off bookings in ${couponCurrency}, and this booking is in ${bookingCurrency}.`,
        };
      }
    }

    const discountMinor = computeCouponDiscountMinor(coupon.type, coupon.value, subtotal);
    return { discountMinor, couponId: coupon.id };
  }

  /**
   * Resolve add-on and bundle cart lines (v1.3) into BookingItem create rows plus
   * the ticket/add-on holds they require. Add-ons are event-scoped; a bundle is
   * expanded into its component lines with bundle pricing applied per unit. Not
   * supported for seat-based (movie) sessions — those keep the ticket-only flow.
   */
  private async resolveCommerceLines(
    session: { id: string; eventId: string },
    input: CreateBookingInput,
    now: Date,
    isSeatBased: boolean,
  ): Promise<CommerceResolution> {
    const wantsAddOns = (input.addOns?.length ?? 0) > 0;
    const wantsBundles = (input.bundles?.length ?? 0) > 0;
    if (!wantsAddOns && !wantsBundles) {
      return { itemCreates: [], subtotalMinor: 0, addOnHolds: [], ticketHolds: [] };
    }
    if (isSeatBased) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Add-ons and bundles are not available for seat-based sessions.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const res: CommerceResolution = {
      itemCreates: [],
      subtotalMinor: 0,
      addOnHolds: [],
      ticketHolds: [],
    };

    // ── Add-ons ──
    if (wantsAddOns) {
      const ids = input.addOns!.map((a) => a.addOnId);
      const addOns = await this.prisma.addOn.findMany({
        where: { id: { in: ids }, eventId: session.eventId },
      });
      const byId = new Map(addOns.map((a) => [a.id, a]));
      for (const line of input.addOns!) {
        const addOn = byId.get(line.addOnId);
        if (!addOn || !addOn.enabled || !onSale(addOn.salesStartAt, addOn.salesEndAt, now)) {
          throw new AppException(
            ErrorCodes.CONFLICT,
            'An add-on in your cart is no longer available.',
            HttpStatus.CONFLICT,
            { addOnId: line.addOnId },
          );
        }
        if (line.quantity > addOn.maxPerOrder) {
          throw new AppException(
            ErrorCodes.VALIDATION_FAILED,
            `You can add at most ${addOn.maxPerOrder} of ${addOn.name} per order.`,
            HttpStatus.BAD_REQUEST,
          );
        }
        const lineTotal = addOn.priceMinor * line.quantity;
        res.subtotalMinor += lineTotal;
        res.addOnHolds.push({ addOnId: addOn.id, quantity: line.quantity });
        res.itemCreates.push({
          kind: BookingItemKind.ADDON,
          addOn: { connect: { id: addOn.id } },
          label: addOn.name,
          quantity: line.quantity,
          unitPriceMinor: addOn.priceMinor,
          lineTotalMinor: lineTotal,
        });
      }
    }

    // ── Bundles ──
    if (wantsBundles) {
      const ids = input.bundles!.map((b) => b.bundleId);
      const bundles = await this.prisma.bundle.findMany({
        where: { id: { in: ids }, eventId: session.eventId },
        include: { items: true },
      });
      const byId = new Map(bundles.map((b) => [b.id, b]));
      for (const line of input.bundles!) {
        const bundle = byId.get(line.bundleId);
        if (!bundle || !bundle.enabled || !onSale(bundle.salesStartAt, bundle.salesEndAt, now)) {
          throw new AppException(
            ErrorCodes.CONFLICT,
            'A bundle in your cart is no longer available.',
            HttpStatus.CONFLICT,
            { bundleId: line.bundleId },
          );
        }
        if (line.quantity > bundle.maxPerOrder) {
          throw new AppException(
            ErrorCodes.VALIDATION_FAILED,
            `You can add at most ${bundle.maxPerOrder} of ${bundle.name} per order.`,
            HttpStatus.BAD_REQUEST,
          );
        }

        // Load component list prices. Ticket components must belong to THIS session.
        const ttIds = bundle.items.map((i) => i.ticketTypeId).filter(Boolean) as string[];
        const addOnIds = bundle.items.map((i) => i.addOnId).filter(Boolean) as string[];
        const [tts, addOns] = await Promise.all([
          ttIds.length
            ? this.prisma.ticketType.findMany({
                // ACTIVE only, for the reason `assertTicketTypeActive` gives: a bundle must
                // not become the way round a ticket type the organizer took off sale.
                where: { id: { in: ttIds }, eventSessionId: session.id, status: 'ACTIVE' },
                select: { id: true, name: true, priceMinor: true },
              })
            : Promise.resolve([]),
          addOnIds.length
            ? this.prisma.addOn.findMany({
                where: { id: { in: addOnIds }, eventId: session.eventId, enabled: true },
                select: { id: true, name: true, priceMinor: true },
              })
            : Promise.resolve([]),
        ]);
        const ttById = new Map(tts.map((t) => [t.id, t]));
        const addOnById = new Map(addOns.map((a) => [a.id, a]));
        if (tts.length !== new Set(ttIds).size || addOns.length !== new Set(addOnIds).size) {
          throw new AppException(
            ErrorCodes.CONFLICT,
            `${bundle.name} isn't available for this session.`,
            HttpStatus.CONFLICT,
            { bundleId: bundle.id },
          );
        }

        const components = bundle.items.map((i) => {
          const meta = i.ticketTypeId ? ttById.get(i.ticketTypeId)! : addOnById.get(i.addOnId!)!;
          return {
            refId: i.ticketTypeId ?? i.addOnId!,
            isTicket: Boolean(i.ticketTypeId),
            listUnitPriceMinor: meta.priceMinor,
            quantity: i.quantity,
          };
        });
        const pricing = priceBundle({
          pricingKind: bundle.pricingKind as 'FIXED' | 'PERCENT_DISCOUNT',
          fixedPriceMinor: bundle.priceMinor,
          discountPercent: bundle.discountPercent,
          components,
          bundleQuantity: line.quantity,
        });
        res.subtotalMinor += pricing.totalMinor;

        for (const c of pricing.components) {
          if (c.isTicket) {
            res.ticketHolds.push({ ticketTypeId: c.refId, quantity: c.quantity });
            res.itemCreates.push({
              kind: BookingItemKind.BUNDLE,
              bundle: { connect: { id: bundle.id } },
              ticketType: { connect: { id: c.refId } },
              label: `${bundle.name} · ${ttById.get(c.refId)!.name}`,
              quantity: c.quantity,
              unitPriceMinor: c.unitPriceMinor,
              lineTotalMinor: c.lineTotalMinor,
            });
          } else {
            res.addOnHolds.push({ addOnId: c.refId, quantity: c.quantity });
            res.itemCreates.push({
              kind: BookingItemKind.BUNDLE,
              bundle: { connect: { id: bundle.id } },
              addOn: { connect: { id: c.refId } },
              label: `${bundle.name} · ${addOnById.get(c.refId)!.name}`,
              quantity: c.quantity,
              unitPriceMinor: c.unitPriceMinor,
              lineTotalMinor: c.lineTotalMinor,
            });
          }
        }
      }
    }

    return res;
  }

  /** Expire stale holds for a session (lazy expiry path). */
  async releaseExpiredHolds(
    eventSessionId?: string,
    options: { consultProvider?: boolean } = {},
  ): Promise<number> {
    const now = new Date();
    // Bounded per sweep so a flash on-sale that abandons tens of thousands of holds
    // can't load them all at once; the remainder is released on the next tick.
    const stale = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.PENDING_PAYMENT,
        holdExpiresAt: { lt: now },
        ...(eventSessionId ? { eventSessionId } : {}),
      },
      /*
        The payment is read for the expiry GUARD, not for the release. A lapsed booking whose
        buyer opened the gateway may have been paid for without us being told - a rejected or
        delayed webhook - and this query cannot tell that apart from an abandoned cart. So the
        provider is asked before the stock goes back. See `PendingPaymentRecoveryService`.
      */
      include: {
        items: true,
        payment: { select: { provider: true, status: true, providerOrderId: true } },
      },
      orderBy: { holdExpiresAt: 'asc' },
      take: 500,
    });
    if (stale.length === 0) return 0;

    /*
      The read above is only a list of CANDIDATES. It is taken outside any transaction, and
      by the time each booking is reached another sweep may have expired it or a late webhook
      confirmed it. `expirePendingBooking` claims the booking with a conditional update first
      and releases stock only if that claim succeeded — see there for the double release and
      the overwritten confirmation this used to allow. The count returned is what THIS sweep
      actually expired, not what it read.
    */
    let expired = 0;
    for (const booking of stale) {
      /*
        THE GUARD. Nothing below may release a booking the provider has taken money for.

        Three outcomes, and only one of them releases anything. `recovered` means the
        provider held a capture we never heard about and the booking has just been put
        through the real confirmation path instead of being thrown away; `hold_back` means we
        could not get an answer, so the stock stays held and the next sweep asks again. Both
        deliberately leave the inventory alone: an undelivered release is a delay, whereas
        releasing a seat whose buyer has paid is money taken for nothing.

        Only bookings that reached the payment gateway are ever asked about, so an abandoned
        cart still costs no network call - see `needsProviderCheck`.
      */
      if (this.recovery) {
        if (options.consultProvider) {
          const outcome = await this.recovery.guardExpiry(booking);
          if (outcome !== 'release') continue;
        } else if (this.recovery.needsProviderCheck(booking)) {
          /*
            A caller that must not make a network call - `create()`, on the booking hot path -
            still must not release this booking blind. It is left for the worker sweep, which
            runs every minute and does consult the provider. The cost is up to a minute of
            delay before a gateway-abandoned seat returns to sale; the alternative is the
            incident this guard exists for.
          */
          continue;
        }
      }
      const claimed = await this.prisma.$transaction((tx) =>
        expirePendingBooking(
          tx,
          booking,
          { inventory: this.inventory, addOnInventory: this.addOnInventory },
          now,
        ),
      );
      if (claimed) expired += 1;
    }
    if (expired > 0) this.logger.log(`Expired ${expired} stale booking hold(s).`);
    return expired;
  }

  /**
   * The buyer cancels their own unpaid booking, and what it holds goes back on sale at once.
   *
   * ── WHY THIS EXISTS OUTSIDE ORCHESTRATION ─────────────────────────────────────────
   * `POST /bookings/:id/cancel` answered "not available" unless booking orchestration was
   * active, which by default it is not. A buyer who changed their mind at the payment screen
   * could only walk away, and everybody else waited out the hold for those seats.
   *
   * Only PENDING_PAYMENT. A confirmed booking has taken money and issued tickets; undoing that
   * is a refund, with the organizer's terms and the gateway involved, and it goes through the
   * refund path rather than being re-implemented here. Only the buyer may cancel; platform
   * staff no longer can by role alone. A guest cancels through
   * `cancelUnpaidAsGuest`, which proves ownership a different way - see there.
   *
   * ── EXACTLY ONCE ──────────────────────────────────────────────────────────────────
   * The release is the claim-first helper the expiry sweep uses: a conditional update from
   * PENDING_PAYMENT to CANCELLED runs first, and only the transaction that won it hands the
   * stock back. A double-click, a sweep expiring the hold at the same moment, or a webhook
   * confirming the booking all leave this call claiming nothing, and it says what the booking
   * became instead.
   *
   * ── A PAYMENT ALREADY UNDER WAY ───────────────────────────────────────────────────
   * An unopened payment (REQUIRES_PAYMENT) is failed with the booking. One already PROCESSING —
   * a Razorpay order the buyer opened — is left as it is, and the booking is still cancelled:
   * the buyer has asked to stop. If the gateway captures anyway, the confirm path finds a
   * booking that can no longer be paid and records the capture as a finance discrepancy for a
   * person to refund (`recordUnappliedCapture`), rather than issuing tickets for released seats.
   */
  async cancelUnpaid(
    user: RequestUser,
    bookingId: string,
  ): Promise<{ id: string; status: string; refundPending: false }> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { items: true, payment: { select: { status: true } } },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    // The buyer only. Staff used to pass by role; they have no cancel route, by design (see the
    // permission matrix, "Customer resources").
    if (booking.userId !== user.id) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot cancel this booking.',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.releaseUnpaid(booking, {
      actorUserId: user.id,
      cancelledBy: 'BUYER',
    });
  }

  /**
   * A guest cancels their own unpaid booking.
   *
   * WHY A GUEST CAN DO THIS NOW
   * This used to answer "Booking cancellation is not available." on the grounds that nothing tied
   * a guest booking to the browser that made it. That stopped being true when `guestSessionHash`
   * was added: the create path writes the hash of the checkout token onto the booking in EVERY
   * orchestration mode, and `GuestSessionVerifier` is what reads it. So there is a real credential
   * to check, and a buyer who changes their mind at the payment screen no longer has to watch a
   * countdown run out while everybody else waits for those seats.
   *
   * The caller checks that proof, because the caller holds the request headers, and it must be
   * `BOUND` rather than merely `UNBOUND`. Cancelling takes tickets away, so it is graded like
   * `claim` and not like a read: a booking id plus a token the caller minted for itself is not
   * enough. Bookings that read `UNBOUND` predate the hash column and their holds expired long ago.
   *
   * Everything after the proof is the signed-in buyer's path exactly - the same claim-first
   * release, the same refusals, the same audit action. It is shared rather than copied so a guest
   * cancel cannot drift into releasing stock differently from an account cancel.
   */
  async cancelUnpaidAsGuest(
    bookingId: string,
  ): Promise<{ id: string; status: string; refundPending: false }> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { items: true, payment: { select: { status: true } } },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    /*
      A booking that belongs to an ACCOUNT is never cancellable through the guest door, however
      good the token looks. `verifyByBookingId` answers about the session hash alone, and an
      account holder's booking carries none - so it reads `UNBOUND`, which the caller already
      refuses. This states the rule at the door instead of resting on that coincidence.
    */
    if (booking.userId) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot cancel this booking.',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.releaseUnpaid(booking, { actorUserId: null, cancelledBy: 'GUEST' });
  }

  /**
   * Put back a counter sale whose cash could not be recorded (`CounterSalesService`), so the
   * seats are not held until they expire for a sale that did not happen. The caller has
   * already checked the staff member belongs to the booking's organization.
   */
  async releaseCounterSale(
    bookingId: string,
    actorUserId: string,
  ): Promise<{ id: string; status: string; refundPending: false }> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { items: true, payment: { select: { status: true } } },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    return this.releaseUnpaid(booking, { actorUserId, cancelledBy: 'COUNTER' });
  }

  /**
   * Give back what an unpaid booking holds, exactly once.
   *
   * The claim-first helper the expiry sweep uses: a conditional update from PENDING_PAYMENT to
   * CANCELLED runs first, and only the transaction that won it hands the stock back. A
   * double-click, a sweep expiring the same hold, or a webhook confirming the booking all leave
   * this claiming nothing, and it reports what the booking became instead.
   */
  private async releaseUnpaid(
    booking: Parameters<typeof cancelPendingBooking>[1] & {
      id: string;
      status: string;
      organizationId: string;
      payment: { status: string } | null;
    },
    by: {
      actorUserId: string | null;
      cancelledBy: 'BUYER' | 'PLATFORM_STAFF' | 'GUEST' | 'COUNTER';
    },
  ): Promise<{ id: string; status: string; refundPending: false }> {
    if (booking.status !== BookingStatus.PENDING_PAYMENT) {
      throw this.notCancellable(booking.status);
    }

    const cancelled = await this.prisma.$transaction((tx) =>
      cancelPendingBooking(tx, booking, {
        inventory: this.inventory,
        addOnInventory: this.addOnInventory,
      }),
    );
    if (!cancelled) {
      // Lost the claim: something moved the booking between the read and the update.
      const now = await this.prisma.booking.findUnique({
        where: { id: booking.id },
        select: { status: true },
      });
      throw this.notCancellable(now?.status ?? booking.status);
    }

    await this.audit.record({
      actorUserId: by.actorUserId,
      organizationId: booking.organizationId,
      action: 'BOOKING_CANCELLED',
      entityType: 'Booking',
      entityId: booking.id,
      metadata: {
        cancelledBy: by.cancelledBy,
        paymentStatus: booking.payment?.status ?? null,
      },
    });
    return { id: booking.id, status: BookingStatus.CANCELLED, refundPending: false };
  }

  /** Why a booking in `status` cannot be cancelled here, in words the buyer can act on. */
  private notCancellable(status: string): AppException {
    if (status === BookingStatus.CONFIRMED || status === BookingStatus.PARTIALLY_REFUNDED) {
      return new AppException(
        ErrorCodes.CONFLICT,
        'This booking is already paid for. To give tickets back, request a refund from My bookings.',
        HttpStatus.CONFLICT,
      );
    }
    return new AppException(
      ErrorCodes.CONFLICT,
      `This booking is ${status.toLowerCase().replace(/_/g, ' ')} and can no longer be cancelled.`,
      HttpStatus.CONFLICT,
    );
  }

  /**
   * Refuse a sale for a session whose start has passed.
   *
   * Status alone cannot answer this: nothing marks a session COMPLETED when it starts, so a
   * past date of a multi-date run still reads SCHEDULED.
   */
  /**
   * A suspended organizer sells nothing, from the moment an admin decides it.
   *
   * ── WHY IT IS HERE AND NOT IN THEIR EVENTS ─────────────────────────────────────────
   * `SUSPENDED` sat in the schema for the whole life of this codebase with nothing writing it and
   * nothing reading it, so an admin had a status that meant nothing and no way to stop a seller at
   * all. Checked at the booking rather than by unpublishing their events: unpublishing destroys
   * what the organizer set up and has to be undone event by event, while this stops the money the
   * moment the decision is made and resumes it the moment it is reversed.
   *
   * Deliberately not EVENT_NOT_PUBLISHED. The event is fine. The customer is told the organizer is
   * not selling right now, which is true and is not the customer's fault.
   */
  /** What the pilot rules read about a cart. The same for a quote and a create. */
  private pilotSale(
    session: {
      screenId: string | null;
      seatMapId?: string | null;
      event: {
        organizationId: string;
        experienceType: string;
        venue?: { country?: string | null } | null;
      };
      screen?: { cinema?: { id: string } | null } | null;
    },
    currency: string,
    totalMinor: number,
    cash: boolean,
    buyerEmails: PilotSale['buyerEmails'],
  ): PilotSale {
    return {
      organizationId: session.event.organizationId,
      reservedSeating: Boolean(session.screenId || session.seatMapId),
      cinema: Boolean(session.screen?.cinema) || session.event.experienceType === 'MOVIE',
      currency,
      provider: totalMinor > 0 ? (this.pilot?.predictProvider(currency) ?? null) : null,
      paymentMethod: cash ? 'CASH' : 'ONLINE',
      totalMinor,
      buyerEmails,
    };
  }

  private assertOrganizerSelling(
    organization: { status?: string | null; name?: string | null } | null | undefined,
  ) {
    if (organization?.status !== OrganizationStatus.SUSPENDED) return;
    throw new AppException(
      ErrorCodes.CONFLICT,
      `${organization.name ?? 'This organizer'} is not selling tickets at the moment. Please try again later.`,
      HttpStatus.CONFLICT,
    );
  }

  private assertSessionNotStarted(startsAt: Date) {
    if (startsAt <= new Date()) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        'This show has already started, so it can no longer be booked.',
        HttpStatus.CONFLICT,
        { startsAt: startsAt.toISOString() },
      );
    }
  }

  /**
   * Refuse a ticket type its organizer has taken off sale.
   *
   * `TicketType.status` was written by the console and read by nothing on the booking path,
   * so setting a ticket type INACTIVE hid nothing and stopped nothing: it kept selling.
   */
  private assertTicketTypeActive(tt: { name: string; status: string }) {
    if (tt.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `${tt.name} is not on sale.`,
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * A booking, for the person who made it and nobody else.
   *
   * Platform staff used to pass here by role alone (`ADMIN` / `SUPER_ADMIN`), with no capability
   * and no record. They read a customer's booking through `getForStaff` instead, behind
   * `BOOKING_READ`, on `GET /admin/bookings/:id`, and every read is audited.
   */
  async getForUser(user: RequestUser, id: string) {
    return this.bookingView(id, (b) => {
      if (b.userId !== user.id) {
        throw new AppException(
          ErrorCodes.FORBIDDEN,
          'You cannot view this booking.',
          HttpStatus.FORBIDDEN,
        );
      }
    });
  }

  /** The same view for the admin console. `authorize` is the capability check and its audit row. */
  async getForStaff(
    id: string,
    authorize: (b: { id: string; userId: string | null; organizationId: string }) => Promise<void>,
  ) {
    return this.bookingView(id, authorize);
  }

  private async bookingView(
    id: string,
    authorize: (b: {
      id: string;
      userId: string | null;
      organizationId: string;
    }) => Promise<void> | void,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            ticketType: { select: { name: true } },
            addOn: { select: { name: true, type: true } },
            bundle: { select: { name: true, type: true } },
          },
        },
        payment: true,
        // Tickets a person can recognise. The account page listed truncated cuids —
        // "cmt9co5zc0…" — which identifies a row to the database and nothing to the buyer.
        tickets: {
          include: {
            ticketType: { select: { name: true } },
            seat: { select: { label: true, row: { select: { label: true } } } },
          },
        },
        // Itemised tax, so the customer's own view of what they paid matches the receipt
        // line for line rather than presenting one opaque total.
        taxLines: {
          select: {
            label: true,
            rateBasisPoints: true,
            baseMinor: true,
            amountMinor: true,
            basis: true,
            inclusive: true,
          },
        },
        event: {
          select: {
            // The id seeds "You might also like", which keeps to this event's market.
            id: true,
            title: true,
            slug: true,
            // The organizer's terms, so the buyer is not offered a refund the organizer
            // never agreed to give.
            refundsEnabled: true,
            refundCutoffHours: true,
            refundPolicy: true,
            // Who ran it: the confirmation offers to follow them. Public profile fields only.
            organization: { select: { id: true, name: true } },
            // The venue's clock, for events that are not cinema showings — which is most
            // of them, and which the first pass at this missed entirely.
            // Name and city too: the confirmation said "Seat A4 - Screen 1" and never where.
            venue: { select: { timezone: true, country: true, name: true, city: true } },
          },
        },
        eventSession: {
          select: {
            // The checkout screen needs it to ask which offers this session advertises.
            // Without it the discount box is a blank field: the organizer's promotion
            // exists, the API will honour it, and nowhere tells the buyer it is there.
            id: true,
            startsAt: true,
            // A showtime means the time AT THE VENUE. Without this the page renders it in
            // the reader's own zone, which is how a ticket and its confirmation email came
            // to disagree by eleven and a half hours. `showTimezone` reads these.
            screen: {
              select: {
                venue: { select: { timezone: true, country: true } },
                cinema: { select: { timezone: true, country: true, name: true, city: true } },
              },
            },
          },
        },
      },
    });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);

    /*
      Which seats these are.

      Reported from QA: the payment screen said "2 x A" — the ticket-type name and a count —
      and never named the seats being bought. For a reserved-seating cinema that is the one
      detail the buyer is checking before they pay, and the last chance to catch a mistake.

      Tickets do not exist yet at this point; they are minted on confirmation. The held
      seats live on ShowSeat, bound to this booking by `holdBookingId`, so that is where the
      labels come from before payment. After confirmation the tickets carry their own
      labels, and both are exposed so the screen reads the same either side of the payment.
    */
    const heldSeats = await this.prisma.showSeat.findMany({
      where: { holdBookingId: booking.id },
      select: { seat: { select: { label: true, row: { select: { label: true } } } } },
    });
    const seatLabels = [
      ...new Set([
        ...booking.tickets.map((t) => t.seatLabel).filter((l): l is string => Boolean(l)),
        ...heldSeats.map((s) => `${s.seat.row.label}${s.seat.label}`),
      ]),
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    await authorize(booking);
    return {
      ...booking,
      /*
        The fees all-in, with the GST on them — the same figures the checkout quote gives, from
        the lines this booking stored. Without them the payment screen lost the "GST on fees"
        row and its rows no longer added up to the total it asked for.
      */
      ...feeTaxSummary(booking.taxLines, booking.customerFeeMinor),
      seatLabels,
      // The venue's clock first; see `showTimezone` for why the cinema's comes after it.
      timeZone: bookingTimeZone(booking),
      /*
        Where the show is, by the same precedence as the zone: the cinema a buyer walks into,
        else the event's venue. A ticket that names a seat and a screen but not the building
        sends somebody with two bookings in one city to the wrong one.
      */
      place: bookingPlace(booking),
      tickets: booking.tickets.map((t) => ({
        ...t,
        seatLabel: t.seatLabel ?? (t.seat ? `${t.seat.row.label}${t.seat.label}` : null),
        ticketTypeName: t.ticketType?.name ?? null,
      })),
    };
  }

  async listForUser(user: RequestUser, page: number, pageSize: number) {
    const where = { userId: user.id };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          // Both zones, so each row can be given the same clock as the booking detail.
          event: {
            select: {
              title: true,
              slug: true,
              venue: { select: { timezone: true, country: true } },
            },
          },
          eventSession: {
            select: {
              startsAt: true,
              screen: { select: SHOW_ZONE_SCREEN_SELECT },
            },
          },
          _count: { select: { tickets: true } },
        },
      }),
    ]);
    /*
      Which clock each row's date is in, by the same rule as `getForUser`. The list sent no
      zone, so "My bookings" printed every date in the reader's browser while the drawer beside
      it used the venue's — on QA one booking showed two different start times on one screen.
    */
    const data = rows.map((booking) => ({ ...booking, timeZone: bookingTimeZone(booking) }));
    return { data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }
}

/**
 * The zone a booking's show time is displayed in: the screen's cinema first, because a
 * screen's own zone is the most specific fact about where it plays, then the event's venue.
 * Null rather than a guess when neither is known — the caller can fall back visibly, but it
 * cannot tell that a confidently returned zone was invented.
 */
function bookingPlace(booking: {
  event?: { venue?: { name?: string | null; city?: string | null } | null } | null;
  eventSession?: {
    screen?: { cinema?: { name?: string | null; city?: string | null } | null } | null;
  } | null;
}): { name: string; city: string | null } | null {
  const cinema = booking.eventSession?.screen?.cinema;
  const venue = booking.event?.venue;
  const name = cinema?.name ?? venue?.name ?? null;
  if (!name) return null;
  // The city is the VENUE's: a cinema's location is edited on its venue, never on the cinema.
  return { name, city: venue?.city ?? cinema?.city ?? null };
}

/**
 * The zone a booking's show time is displayed in. `showTimezone` owns the order (venue first,
 * then a cinema zone somebody chose, then the country's only zone); null rather than a guess.
 */
function bookingTimeZone(booking: {
  event?: { venue?: ShowZoneVenue | null } | null;
  eventSession?: { screen?: ShowZoneScreen | null } | null;
}): string | null {
  return showTimezone(booking.eventSession?.screen, booking.event?.venue);
}
