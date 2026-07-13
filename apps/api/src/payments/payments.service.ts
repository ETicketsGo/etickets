import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  BookingStatus,
  NotificationType,
  PaymentAttemptStatus,
  PaymentStatus,
  TicketStatus,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { InventoryService } from '../inventory/inventory.service';
import { MockPaymentProvider } from './provider/mock-payment.provider';
import type { PaymentEvent, WebhookInput } from './provider/payment-provider.interface';
import { AppException, ErrorCodes } from '../common/errors';

const serial = () => `TKT-${randomBytes(6).toString('hex').toUpperCase()}`;
const nonce = () => randomBytes(8).toString('hex');

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: MockPaymentProvider,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly inventory: InventoryService,
  ) {}

  /** Issue a provider refund for a captured payment. */
  refundPayment(providerRef: string, amountMinor: number, reason?: string) {
    return this.provider.refund({ providerRef, amountMinor, reason });
  }

  /** Create a payment intent for a pending booking. */
  async createIntent(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true },
    });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    if (booking.status !== BookingStatus.PENDING_PAYMENT) {
      throw new AppException(
        ErrorCodes.BOOKING_NOT_PAYABLE,
        'This booking is not awaiting payment.',
        HttpStatus.CONFLICT,
      );
    }
    if (booking.holdExpiresAt < new Date()) {
      throw new AppException(
        ErrorCodes.BOOKING_EXPIRED,
        'This booking hold has expired.',
        HttpStatus.CONFLICT,
      );
    }

    const intent = await this.provider.createPayment({
      bookingId,
      amountMinor: booking.totalMinor,
      currency: booking.currency,
      buyerEmail: booking.buyerEmail,
      idempotencyKey: booking.id,
    });
    await this.prisma.payment.update({
      where: { bookingId },
      data: { status: PaymentStatus.PROCESSING, providerRef: intent.providerRef },
    });
    return intent;
  }

  /**
   * Simulates the payment provider completing (or failing) a charge and calling
   * our webhook. Payment is NEVER confirmed from the browser redirect directly.
   */
  async mockPay(bookingId: string, outcome: 'succeeded' | 'failed') {
    const payment = await this.prisma.payment.findUnique({ where: { bookingId } });
    if (!payment)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Payment not found.', HttpStatus.NOT_FOUND);

    const event: PaymentEvent = {
      type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
      providerRef: payment.providerRef ?? `mock_pi_${randomBytes(8).toString('hex')}`,
      bookingId,
      amountMinor: payment.amountMinor,
    };
    const signed = this.provider.signEvent(event);
    return this.handleWebhook(signed);
  }

  /** Public webhook entry point — verifies signature, then processes. */
  async handleWebhook(input: WebhookInput) {
    const event = await this.provider.verifyWebhook(input);
    if (event.type === 'payment.succeeded') {
      return this.confirm(event);
    }
    return this.fail(event);
  }

  private async confirm(event: PaymentEvent) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: event.bookingId },
      include: { items: true, event: { select: { experienceType: true } } },
    });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);

    // Idempotent: a re-delivered webhook must not double-confirm or double-issue.
    if (booking.status === BookingStatus.CONFIRMED) {
      return { status: 'already_confirmed', bookingId: booking.id };
    }
    if (booking.status !== BookingStatus.PENDING_PAYMENT) {
      throw new AppException(
        ErrorCodes.BOOKING_NOT_PAYABLE,
        `Booking cannot be confirmed from status ${booking.status}.`,
        HttpStatus.CONFLICT,
      );
    }

    const strategy = this.inventory.forExperienceType(booking.event.experienceType);

    await this.prisma.$transaction(async (tx) => {
      // Settle inventory (held → sold) via the experience's strategy, then issue
      // one ticket per unit. See ADR-010.
      await strategy.confirm(tx, booking.items);
      for (const item of booking.items) {
        for (let n = 0; n < item.quantity; n++) {
          await tx.ticket.create({
            data: {
              bookingId: booking.id,
              ticketTypeId: item.ticketTypeId,
              eventSessionId: booking.eventSessionId,
              organizationId: booking.organizationId,
              serial: serial(),
              nonce: nonce(),
              status: TicketStatus.ACTIVE,
              holderName: booking.buyerName,
              holderEmail: booking.buyerEmail,
            },
          });
        }
      }
      await tx.payment.update({
        where: { bookingId: booking.id },
        data: { status: PaymentStatus.SUCCEEDED, providerRef: event.providerRef },
      });
      await tx.paymentAttempt.create({
        data: {
          payment: { connect: { bookingId: booking.id } },
          status: PaymentAttemptStatus.SUCCEEDED,
          providerRef: event.providerRef,
          rawEvent: event as unknown as object,
        },
      });
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.CONFIRMED, confirmedAt: new Date() },
      });
      if (booking.couponId) {
        await tx.coupon.update({
          where: { id: booking.couponId },
          data: { redemptions: { increment: 1 } },
        });
      }
    });

    const ticketCount = booking.items.reduce((s, i) => s + i.quantity, 0);
    await this.notifications.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: booking.userId,
      toEmail: booking.buyerEmail,
      payload: { bookingId: booking.id, tickets: ticketCount },
    });
    await this.audit.record({
      organizationId: booking.organizationId,
      action: 'BOOKING_CONFIRMED',
      entityType: 'Booking',
      entityId: booking.id,
      metadata: { providerRef: event.providerRef },
    });
    return { status: 'confirmed', bookingId: booking.id, tickets: ticketCount };
  }

  private async fail(event: PaymentEvent) {
    const booking = await this.prisma.booking.findUnique({ where: { id: event.bookingId } });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);

    await this.prisma.payment.update({
      where: { bookingId: booking.id },
      data: { status: PaymentStatus.FAILED },
    });
    await this.prisma.paymentAttempt.create({
      data: {
        payment: { connect: { bookingId: booking.id } },
        status: PaymentAttemptStatus.FAILED,
        providerRef: event.providerRef,
        rawEvent: event as unknown as object,
      },
    });
    await this.notifications.send({
      type: NotificationType.PAYMENT_FAILED,
      userId: booking.userId,
      toEmail: booking.buyerEmail,
      payload: { bookingId: booking.id },
    });
    // The inventory hold stays until it expires, allowing the buyer to retry.
    return { status: 'failed', bookingId: booking.id };
  }
}
