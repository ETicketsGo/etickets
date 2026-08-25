import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  BookingItemKind,
  BookingStatus,
  EventStatus,
  ExperienceType,
  FeeMode,
  PaymentStatus,
  SessionStatus,
  priceBundle,
} from '@eticketsgo/shared-types';
import type { InventoryLine } from '../inventory/inventory-strategy.interface';
import type { CreateBookingInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { PricingStrategiesService } from '../pricing/pricing-strategies.service';
import { computeCouponDiscountMinor } from '../pricing/coupon-pricing';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { AddOnInventoryService, type AddOnLine } from '../commerce/addon-inventory.service';
import { onSale } from '../commerce/addons.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';
import { InventoryLockShadowService } from '../inventory/locking/inventory-lock-shadow.service';
import { BookingShadowObserver } from './orchestration/booking-shadow-observer.service';

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
            venue: { select: { country: true } },
            organization: { select: { registeredCountry: true, registeredRegion: true } },
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

    // Seat-based experiences (movies): every line must carry seats that belong to
    // this session and match their ticket type's price category. Actual seat
    // availability is enforced atomically by the strategy's conditional hold.
    const isSeatBased = session.event.experienceType === ExperienceType.MOVIE;
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
    const taxPlace = {
      country:
        session.event.venue?.country ?? session.event.organization?.registeredCountry ?? null,
      region: session.event.organization?.registeredRegion ?? null,
      at: now,
    };
    const fees = await this.pricing.quote(subtotal, feeMode, discountMinor, 'INR', taxPlace);

    const holdExpiresAt = new Date(now.getTime() + this.holdMinutes * 60 * 1000);

    // The inventory model is chosen by the experience type — general admission
    // for events today, seat-based for movies in a later PR — without this
    // engine changing. See ADR-010.
    const strategy = this.inventory.forExperienceType(session.event.experienceType);

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
          status: BookingStatus.PENDING_PAYMENT,
          feeMode,
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
          payment: {
            create: {
              provider: 'mock',
              status: PaymentStatus.REQUIRES_PAYMENT,
              amountMinor: fees.totalMinor,
            },
          },
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

    const result = {
      id: booking.id,
      status: booking.status,
      currency: booking.currency,
      holdExpiresAt: booking.holdExpiresAt,
      fees,
      payment: { id: booking.payment?.id, status: booking.payment?.status },
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
  async applyCoupon(user: RequestUser | null, bookingId: string, code: string | null) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        payment: true,
        event: { select: { feeMode: true } },
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

    const fees = await this.pricing.quote(
      booking.subtotalMinor,
      booking.feeMode as FeeMode,
      discountMinor,
      booking.currency,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          couponId,
          discountMinor: fees.discountMinor,
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
        tickets: true,
        // Itemised tax, so the customer's own view of what they paid matches the receipt
        // line for line rather than presenting one opaque total.
        taxLines: {
          select: { label: true, rateBasisPoints: true, baseMinor: true, amountMinor: true },
        },
        event: { select: { title: true, slug: true } },
        eventSession: { select: { startsAt: true } },
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
    return { ...booking, seatLabels };
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
