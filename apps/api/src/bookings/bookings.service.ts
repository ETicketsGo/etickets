import { HttpStatus, Injectable, Logger } from '@nestjs/common';
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

/** A resolved BookingItem row plus the holds it needs, produced by commerce expansion. */
interface CommerceResolution {
  itemCreates: Prisma.BookingItemCreateWithoutBookingInput[];
  subtotalMinor: number;
  addOnHolds: AddOnLine[];
  ticketHolds: InventoryLine[];
}

const HOLD_MINUTES = 10;

@Injectable()
export class BookingsService {
  private readonly logger = new Logger('Bookings');

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly pricingStrategies: PricingStrategiesService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly addOnInventory: AddOnInventoryService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Creates a PENDING_PAYMENT booking with an atomic, oversell-proof inventory
   * hold. Fee amounts are snapshotted onto the booking so later rule changes
   * never alter historical orders.
   */
  async create(user: RequestUser | null, input: CreateBookingInput, idempotencyKey?: string) {
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
      include: { event: true },
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
    const fees = await this.pricing.quote(subtotal, feeMode, discountMinor);

    const holdExpiresAt = new Date(now.getTime() + HOLD_MINUTES * 60 * 1000);

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
        event: { select: { title: true, slug: true } },
        eventSession: { select: { startsAt: true } },
      },
    });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
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
    return booking;
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
