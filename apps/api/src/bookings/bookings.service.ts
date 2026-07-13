import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BookingStatus,
  EventStatus,
  FeeMode,
  PaymentStatus,
  SessionStatus,
} from '@eticketsgo/shared-types';
import type { CreateBookingInput } from '@eticketsgo/validation';
import { PrismaService } from '../prisma/prisma.service';
import { PricingService } from '../pricing/pricing.service';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

const HOLD_MINUTES = 10;

@Injectable()
export class BookingsService {
  private readonly logger = new Logger('Bookings');

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
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
    let subtotal = 0;
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
      subtotal += tt.priceMinor * item.quantity;
    }

    const { discountMinor, couponId } = await this.resolveCoupon(input.couponCode, subtotal);
    const feeMode = session.event.feeMode as FeeMode;
    const fees = await this.pricing.quote(subtotal, feeMode, discountMinor);

    const holdExpiresAt = new Date(now.getTime() + HOLD_MINUTES * 60 * 1000);

    // The inventory model is chosen by the experience type — general admission
    // for events today, seat-based for movies in a later PR — without this
    // engine changing. See ADR-010.
    const strategy = this.inventory.forExperienceType(session.event.experienceType);

    const booking = await this.prisma.$transaction(async (tx) => {
      // Atomic, oversell-proof hold delegated to the resolved strategy.
      await strategy.reserve(tx, input.items);

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
            create: input.items.map((i) => {
              const tt = byId.get(i.ticketTypeId)!;
              return {
                ticketTypeId: i.ticketTypeId,
                quantity: i.quantity,
                unitPriceMinor: tt.priceMinor,
                lineTotalMinor: tt.priceMinor * i.quantity,
              };
            }),
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

    const raw =
      coupon.type === 'PERCENT' ? Math.round((subtotal * coupon.value) / 100) : coupon.value;
    return { discountMinor: Math.min(subtotal, raw), couponId: coupon.id };
  }

  /** Expire stale holds for a session (lazy expiry path). */
  async releaseExpiredHolds(eventSessionId?: string): Promise<number> {
    const stale = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.PENDING_PAYMENT,
        holdExpiresAt: { lt: new Date() },
        ...(eventSessionId ? { eventSessionId } : {}),
      },
      include: { items: true, event: { select: { experienceType: true } } },
    });
    if (stale.length === 0) return 0;

    for (const booking of stale) {
      const strategy = this.inventory.forExperienceType(booking.event.experienceType);
      await this.prisma.$transaction(async (tx) => {
        await strategy.release(tx, booking.items);
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
        items: { include: { ticketType: { select: { name: true } } } },
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
