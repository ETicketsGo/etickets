import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  BookingItemKind,
  BookingStatus,
  EventStatus,
  FeeMode,
  PaymentStatus,
  SessionStatus,
  priceBundle,
  blocksBooking,
  type CinemaFormat,
  type ClimateType,
  type LocalBodyType,
} from '@eticketsgo/shared-types';
import type { InventoryLine } from '../inventory/inventory-strategy.interface';
import type { CreateBookingInput, QuoteBookingInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { PricingStrategiesService } from '../pricing/pricing-strategies.service';
import { computeCouponDiscountMinor } from '../pricing/coupon-pricing';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { AddOnInventoryService, type AddOnLine } from '../commerce/addon-inventory.service';
import { onSale } from '../commerce/addons.service';
import { AppException, ErrorCodes } from '../common/errors';
import { currencyForCountry } from '../common/country';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';
import { InventoryLockShadowService } from '../inventory/locking/inventory-lock-shadow.service';
import { BookingShadowObserver } from './orchestration/booking-shadow-observer.service';
import { PaymentsService } from '../payments/payments.service';
import { CinemaPricingPolicyService } from '../pricing/cinema-policy/cinema-pricing-policy.service';
import type {
  PolicyContext,
  PolicyResolution,
} from '../pricing/cinema-policy/cinema-pricing-policy.resolver';
import { applyPolicy, type PolicyEffect } from '../pricing/cinema-policy/apply-policy';

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
  ) {
    if (idempotencyKey) {
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: { scope_key: { scope: 'booking:create', key: idempotencyKey } },
      });
      if (existing?.status === 'COMPLETED' && existing.responseJson) {
        return existing.responseJson as Prisma.JsonObject;
      }
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

    // Release any expired holds for this session so freed stock is bookable.
    await this.releaseExpiredHolds(input.eventSessionId);

    const ticketTypeIds = input.items.map((i) => i.ticketTypeId);
    const ticketTypes = await this.prisma.ticketType.findMany({
      where: { id: { in: ticketTypeIds }, eventSessionId: input.eventSessionId },
    });
    const byId = new Map(ticketTypes.map((t) => [t.id, t]));

    const now = new Date();
    for (const item of input.items) {
      const tt = byId.get(item.ticketTypeId);
      if (!tt) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'One or more ticket types are invalid for this session.',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (item.quantity > tt.maxPerOrder) {
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
      const allSeatIds = input.items.flatMap((i) => i.seatIds ?? []);
      for (const item of input.items) {
        if (!item.seatIds || item.seatIds.length !== item.quantity) {
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
      for (const item of input.items) {
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

    const { discountMinor, couponId } = await this.resolveCoupon(input.couponCode, subtotal);
    const feeMode = session.event.feeMode as FeeMode;
    const currency = this.cartCurrency(
      input.items.map((i) => byId.get(i.ticketTypeId)!),
      session.event.venue?.country,
    );
    const taxPlace = {
      country:
        session.event.venue?.country ?? session.event.organization?.registeredCountry ?? null,
      /*
        `region` is the PLACE OF SUPPLY — where the event is HELD, per s.12(6) of India's
        IGST Act — and `supplierRegion` is where the seller is registered. Comparing them is
        what decides CGST + SGST against IGST.

        These were the same value before: the seller's own state was being used as the place
        of supply, which is right only when the organizer never sells outside their state.
      */
      region: session.event.venue?.region ?? session.event.organization?.registeredRegion ?? null,
      supplierRegion: session.event.organization?.registeredRegion ?? null,
      /*
        Where the BUYER is, which is a different question from where the event is.

        Admission follows the venue; a platform's service follows the recipient. On one
        Indian order that produces CGST + SGST on the ticket and IGST on the convenience
        fee, which is exactly what a real competitor's order summary shows.

        Optional, and safe to omit: the amount does not change either way, only which
        government is owed it. Absent, the engine treats the sale as intra-state — the same
        answer the law reaches for a buyer with no address on record.
      */
      customerRegion: input.buyerRegion?.trim() || null,
      at: now,
    };
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
      Fail closed. A market declared regulated whose rule cannot be resolved must not fall
      through to the platform's ordinary fee schedule — that is the silent non-compliance
      this whole subsystem exists to prevent, and it would look exactly like a normal sale.

      REQUIRES_APPROVAL is deliberately NOT here: it is a resolved policy whose fee position
      is unconfirmed, so the fee is suppressed to zero and the ticket still sells. Refusing to
      sell in a whole state over an unconfirmed fee schedule would be the larger harm.
    */
    if (blocksBooking(policy.resolution.status)) {
      await this.audit.record({
        organizationId: session.event.organizationId,
        action: 'CINEMA_PRICING_POLICY_BLOCKED_BOOKING',
        entityType: 'EventSession',
        entityId: session.id,
        metadata: this.policyService?.auditFor(policy.resolution, policy.context) ?? {},
      });
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'This showing cannot be sold online yet: its regulatory pricing is not configured. ' +
          policy.resolution.explanation,
        HttpStatus.CONFLICT,
      );
    }

    const fees = await this.pricing.quote(
      subtotal,
      feeMode,
      discountMinor,
      currency,
      taxPlace,
      admissionLines,
      policy.effect,
    );

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
    if (wantsCash && !session.event.organization.cashPaymentsEnabled) {
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
    const holdExpiresAt = wantsCash
      ? session.startsAt
      : new Date(now.getTime() + this.holdMinutes * 60 * 1000);

    // The inventory model is chosen by the experience type — general admission
    // for events today, seat-based for movies in a later PR — without this
    // engine changing. See ADR-010.
    const strategy = this.inventory.forSeating(isSeatBased);

    const ticketLines: InventoryLine[] = input.items.map((i) => ({
      ticketTypeId: i.ticketTypeId,
      quantity: i.quantity,
      seatIds: i.seatIds,
    }));

    const booking = await this.prisma.$transaction(async (tx) => {
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
            })),
          },
          totalMinor: fees.totalMinor,
          holdExpiresAt,
          idempotencyKey: idempotencyKey ?? null,
          items: {
            create: [
              ...priceQuote.lines.map((pl) => ({
                kind: BookingItemKind.TICKET,
                ticketTypeId: pl.ticketTypeId,
                quantity: pl.quantity,
                unitPriceMinor: pl.unitPriceMinor,
                lineTotalMinor: pl.lineTotalMinor,
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
      return created;
    });

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

    if (idempotencyKey) {
      await this.prisma.idempotencyRecord
        .upsert({
          where: { scope_key: { scope: 'booking:create', key: idempotencyKey } },
          create: {
            scope: 'booking:create',
            key: idempotencyKey,
            status: 'COMPLETED',
            responseJson: result as unknown as Prisma.InputJsonValue,
          },
          update: { status: 'COMPLETED', responseJson: result as unknown as Prisma.InputJsonValue },
        })
        .catch(() => undefined);
    }

    return result;
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
        cinema: {
          country: string | null;
          region: string | null;
          district: string | null;
          city: string | null;
          localBodyType: LocalBodyType | null;
          cinemaFormat: CinemaFormat | null;
          climateType: ClimateType | null;
          venue?: { country: string | null; region: string | null; city: string | null } | null;
        };
      } | null;
    },
    currency: string,
    admissionLines: { unitPriceMinor: number; quantity: number; category?: string | null }[],
    at: Date,
  ): Promise<{ resolution: PolicyResolution; effect: PolicyEffect; context: PolicyContext }> {
    const cinema = session.screen?.cinema ?? null;
    // Seat classes in the cart, so a rule written for one class can match. De-duplicated
    // because the rule asks "is this class present", not "how many".
    const seatCategories = [
      ...new Set(admissionLines.map((l) => l.category).filter((c): c is string => Boolean(c))),
    ];
    const context: PolicyContext = {
      country: cinema?.country ?? cinema?.venue?.country ?? null,
      region: cinema?.region ?? cinema?.venue?.region ?? null,
      district: cinema?.district ?? null,
      city: cinema?.city ?? cinema?.venue?.city ?? null,
      currency,
      localBodyType: cinema?.localBodyType ?? null,
      cinemaFormat: cinema?.cinemaFormat ?? null,
      climateType: cinema?.climateType ?? null,
      seatCategories,
      at,
    };
    /*
      No policy service wired — a unit harness. Report NOT_REGULATED explicitly rather than
      pretending a lookup happened: the caller then takes exactly the same path as any
      unregulated market, and nothing silently claims compliance it never checked.
    */
    const resolution: PolicyResolution = this.policyService
      ? await this.policyService.resolve(context)
      : {
          status: 'NOT_REGULATED',
          policy: null,
          explanation: 'Cinema pricing policy resolution is not configured in this context.',
          specificity: -1,
        };
    this.policyService?.logResolution(resolution, context);
    // Tickets, not lines: a maintenance charge is per head. Add-ons and bundles are not
    // admissions and carry no charge, which is why only admission lines are counted.
    const ticketCount = admissionLines.reduce((n, l) => n + Math.max(0, l.quantity), 0);
    return { resolution, effect: applyPolicy(resolution, ticketCount), context };
  }

  private admissionLinesFor(
    event: { experienceType: string; category?: string | null },
    items: { ticketTypeId: string; quantity: number }[],
    byId: Map<string, { priceMinor: number }>,
  ): { unitPriceMinor: number; quantity: number; category: string }[] {
    const category = event.experienceType === 'MOVIE' ? 'MOVIE' : (event.category ?? '');
    return items
      .map((i) => ({
        unitPriceMinor: byId.get(i.ticketTypeId)?.priceMinor ?? 0,
        quantity: i.quantity,
        category,
      }))
      .filter((line) => line.quantity > 0);
  }

  private cartCurrency(
    priced: { currency?: string | null }[],
    venueCountry: string | null | undefined,
  ): string {
    /*
      A line with no currency contributes no opinion rather than crashing the booking.

      `TicketType.currency` is NOT NULL with a default, so in real data this is always
      present — a missing one means a `select` that did not ask for the column. Reading
      through it would throw here, which turns a query oversight into a customer unable to
      buy a ticket. Skipping it lets the venue answer instead, and the venue's answer is
      the same one the ticket type would have been created with.
    */
    const distinct = [
      ...new Set(priced.map((p) => p.currency?.trim().toUpperCase()).filter(Boolean)),
    ] as string[];
    if (distinct.length > 1) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'These tickets are priced in different currencies and cannot be bought together.',
        HttpStatus.BAD_REQUEST,
        { currencies: distinct },
      );
    }
    // An empty cart still needs a currency for the zero-total row it produces; the venue
    // answers that, and INR remains the answer for a market with no mapping.
    return distinct[0] ?? currencyForCountry(venueCountry) ?? 'INR';
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

    const ticketTypes = await this.prisma.ticketType.findMany({
      where: {
        id: { in: input.items.map((i) => i.ticketTypeId) },
        eventSessionId: input.eventSessionId,
      },
    });
    const byId = new Map(ticketTypes.map((t) => [t.id, t]));
    for (const item of input.items) {
      if (!byId.has(item.ticketTypeId)) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          'One or more ticket types are invalid for this session.',
          HttpStatus.BAD_REQUEST,
        );
      }
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

    const { discountMinor, couponId } = await this.resolveCoupon(input.couponCode, subtotal);
    // The same derivation `create` uses. A quote and the booking that follows it disagreeing
    // about the currency would be a price shown in one denomination and charged in another.
    const currency = this.cartCurrency(
      input.items.map((i) => byId.get(i.ticketTypeId)!),
      session.event.venue?.country,
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
      {
        country:
          session.event.venue?.country ?? session.event.organization?.registeredCountry ?? null,
        // Place of supply is the venue's state; the seller's is a separate question. A quote
        // and the booking that follows it must not disagree about either.
        region: session.event.venue?.region ?? session.event.organization?.registeredRegion ?? null,
        supplierRegion: session.event.organization?.registeredRegion ?? null,
        // The comment above applies to this too: quote it with the buyer's state or the
        // breakdown shown before they commit is not the one they are charged.
        customerRegion: input.buyerRegion?.trim() || null,
        at: now,
      },
      quoteAdmissionLines,
      quotePolicy.effect,
    );

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
  async extendHold(user: RequestUser | null, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        userId: true,
        status: true,
        holdExpiresAt: true,
        holdExtensions: true,
        organizationId: true,
      },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }

    /*
      A guest booking has no owner and is reached by its unguessable id — the same rule the
      payment path uses. An authenticated user may only extend their own.
    */
    if (booking.userId && user && booking.userId !== user.id) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot change this booking.',
        HttpStatus.FORBIDDEN,
      );
    }

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
    if (booking.holdExtensions >= max) {
      throw new AppException(
        ErrorCodes.CONFLICT,
        `This hold has already been extended ${max} times. Complete the payment or start again.`,
        HttpStatus.CONFLICT,
        { holdExtensions: booking.holdExtensions, maxHoldExtensions: max },
      );
    }

    const holdExpiresAt = new Date(Date.now() + this.holdMinutes * 60 * 1000);
    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { holdExpiresAt, holdExtensions: { increment: 1 } },
      select: { holdExpiresAt: true, holdExtensions: true },
    });

    return {
      holdExpiresAt: updated.holdExpiresAt,
      holdExtensions: updated.holdExtensions,
      maxHoldExtensions: max,
      /** What the UI needs in order to stop offering a button that will now be refused. */
      extensionsRemaining: Math.max(0, max - updated.holdExtensions),
    };
  }

  async applyCoupon(user: RequestUser | null, bookingId: string, code: string | null) {
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
          },
        },
      },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    if (user && booking.userId && booking.userId !== user.id) {
      throw new AppException(ErrorCodes.FORBIDDEN, 'Forbidden.', HttpStatus.FORBIDDEN);
    }
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
    const { discountMinor, couponId } = await this.resolveCoupon(trimmed, booking.subtotalMinor);
    // An unrecognised code is told to the buyer rather than silently ignored: a discount box
    // that accepts anything and changes nothing is worse than one that says no.
    if (trimmed && !couponId) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'That code is not valid for this booking.',
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
      {
        country:
          booking.event?.venue?.country ?? booking.event?.organization?.registeredCountry ?? null,
        region:
          booking.event?.venue?.region ?? booking.event?.organization?.registeredRegion ?? null,
        supplierRegion: booking.event?.organization?.registeredRegion ?? null,
        /*
          Read from the booking, not re-derived. This runs after the buyer has committed, and
          the place of supply that goes on their invoice is the one that applied when they
          bought — not whatever a later lookup would return.
        */
        customerRegion: booking.customerRegion ?? null,
        at: new Date(),
      },
      // No admission lines: this re-prices a stored subtotal, and a banded tax rule would
      // refuse rather than rate the whole order in one band — which is the correct refusal.
      undefined,
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

  private async resolveCoupon(code: string | undefined, subtotal: number) {
    if (!code) return { discountMinor: 0, couponId: null as string | null };
    const coupon = await this.prisma.coupon.findUnique({ where: { code } });
    const now = new Date();
    const valid =
      coupon &&
      coupon.status === 'ACTIVE' &&
      (!coupon.startsAt || coupon.startsAt <= now) &&
      (!coupon.endsAt || coupon.endsAt >= now) &&
      (coupon.maxRedemptions === null || coupon.redemptions < coupon.maxRedemptions);
    if (!valid) return { discountMinor: 0, couponId: null };

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
                where: { id: { in: ttIds }, eventSessionId: session.id },
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
  async releaseExpiredHolds(eventSessionId?: string): Promise<number> {
    // Bounded per sweep so a flash on-sale that abandons tens of thousands of holds
    // can't load them all at once; the remainder is released on the next tick.
    const stale = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.PENDING_PAYMENT,
        holdExpiresAt: { lt: new Date() },
        ...(eventSessionId ? { eventSessionId } : {}),
      },
      include: { items: true, event: { select: { experienceType: true } } },
      orderBy: { holdExpiresAt: 'asc' },
      take: 500,
    });
    if (stale.length === 0) return 0;

    for (const booking of stale) {
      const strategy = this.inventory.forExperienceType(booking.event.experienceType);
      // Ticket holds (direct + bundle ticket components) vs add-on holds (v1.3).
      const ticketLines = booking.items
        .filter((i) => i.ticketTypeId)
        .map((i) => ({ ticketTypeId: i.ticketTypeId as string, quantity: i.quantity }));
      const addOnLines = booking.items
        .filter((i) => i.addOnId)
        .map((i) => ({ addOnId: i.addOnId as string, quantity: i.quantity }));
      await this.prisma.$transaction(async (tx) => {
        if (ticketLines.length > 0) {
          await strategy.release(tx, {
            eventSessionId: booking.eventSessionId,
            bookingId: booking.id,
            holdExpiresAt: booking.holdExpiresAt,
            lines: ticketLines,
          });
        }
        if (addOnLines.length > 0) {
          await this.addOnInventory.release(tx, addOnLines);
        }
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: BookingStatus.EXPIRED, cancelledAt: new Date() },
        });
        await tx.payment.updateMany({
          where: { bookingId: booking.id, status: PaymentStatus.REQUIRES_PAYMENT },
          data: { status: PaymentStatus.FAILED },
        });
      });
    }
    this.logger.log(`Expired ${stale.length} stale booking hold(s).`);
    return stale.length;
  }

  async getForUser(user: RequestUser, id: string) {
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
          select: { label: true, rateBasisPoints: true, baseMinor: true, amountMinor: true },
        },
        event: {
          select: {
            title: true,
            slug: true,
            // The organizer's terms, so the buyer is not offered a refund the organizer
            // never agreed to give.
            refundsEnabled: true,
            refundCutoffHours: true,
            // The venue's clock, for events that are not cinema showings — which is most
            // of them, and which the first pass at this missed entirely.
            venue: { select: { timezone: true } },
          },
        },
        eventSession: {
          select: {
            // The checkout screen needs it to ask which offers this session advertises.
            // Without it the discount box is a blank field: the organizer's promotion
            // exists, the API will honour it, and nowhere tells the buyer it is there.
            id: true,
            startsAt: true,
            // A showtime means the time AT THE CINEMA. Without this the page renders it in
            // the reader's own zone, which is how a ticket and its confirmation email came
            // to disagree by eleven and a half hours.
            screen: { select: { cinema: { select: { timezone: true } } } },
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

    const isOwner = booking.userId === user.id;
    const isAdmin =
      user.roles.includes('ADMIN' as never) || user.roles.includes('SUPER_ADMIN' as never);
    if (!isOwner && !isAdmin) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot view this booking.',
        HttpStatus.FORBIDDEN,
      );
    }
    return {
      ...booking,
      seatLabels,
      // Cinema first (a screen's own zone is the most specific fact), then the venue.
      timeZone:
        booking.eventSession?.screen?.cinema?.timezone ?? booking.event?.venue?.timezone ?? null,
      tickets: booking.tickets.map((t) => ({
        ...t,
        seatLabel: t.seatLabel ?? (t.seat ? `${t.seat.row.label}${t.seat.label}` : null),
        ticketTypeName: t.ticketType?.name ?? null,
      })),
    };
  }

  async listForUser(user: RequestUser, page: number, pageSize: number) {
    const where = { userId: user.id };
    const [total, data] = await this.prisma.$transaction([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          event: { select: { title: true, slug: true } },
          eventSession: { select: { startsAt: true } },
          _count: { select: { tickets: true } },
        },
      }),
    ]);
    return { data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }
}
