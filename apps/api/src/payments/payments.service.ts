import { HttpStatus, Inject, Injectable } from '@nestjs/common';
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
import { AddOnInventoryService } from '../commerce/addon-inventory.service';
import { MockPaymentProvider } from './provider/mock-payment.provider';
import {
  PAYMENT_PROVIDER,
  type PaymentEvent,
  type PaymentProvider,
  type WebhookInput,
} from './provider/payment-provider.interface';
import { PaymentOrchestrator } from './orchestration/payment-orchestrator.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';
import { BookingReferenceService } from '../bookings/booking-reference.service';

const serial = () => `TKT-${randomBytes(6).toString('hex').toUpperCase()}`;
const nonce = () => randomBytes(8).toString('hex');

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    // The selected gateway (mock | razorpay | stripe) for real charge/verify/refund.
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    // The mock is used only by the dev-only mockPay() path to sign a test event.
    private readonly mockProvider: MockPaymentProvider,
    // Routes + fails over across configured providers (resilient createPayment).
    private readonly orchestrator: PaymentOrchestrator,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly inventory: InventoryService,
    private readonly addOnInventory: AddOnInventoryService,
    private readonly metrics: MetricsService,
    private readonly bookingReference: BookingReferenceService,
  ) {}

  /**
   * Issue a provider refund for a captured payment. Routed through the orchestrator
   * for retry/timeout/circuit protection; `provider` (when known) keeps the refund
   * on the gateway that took the payment.
   */
  refundPayment(
    providerRef: string,
    amountMinor: number,
    reason?: string,
    provider?: string,
    currency?: string,
  ) {
    return this.orchestrator.refund({ providerRef, amountMinor, reason, currency }, { provider });
  }

  /** Whether the mock "simulate payment" path is allowed (dev/test only). */
  private readonly mockEnabled =
    process.env.PAYMENTS_MOCK_ENABLED !== 'false' && process.env.NODE_ENV !== 'production';

  /** Create a payment intent for a pending booking (owner or platform admin only). */
  async createIntent(bookingId: string, user?: RequestUser) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        payment: true,
        // Country feeds the multi-country payment routing dimension (see webhook path).
        event: { select: { venue: { select: { country: true } } } },
      },
    });
    if (!booking)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    // Ownership: an authenticated user may only pay their own booking (guest
    // bookings have no owner and are paid via the unguessable booking id).
    if (booking.userId && user) {
      const isAdmin =
        user.roles.includes('ADMIN' as never) || user.roles.includes('SUPER_ADMIN' as never);
      if (booking.userId !== user.id && !isAdmin) {
        throw new AppException(
          ErrorCodes.FORBIDDEN,
          'You cannot pay for this booking.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
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

    // Route through the orchestrator: it resolves the configured provider chain for
    // this currency and fails over across constructed adapters. In local/dev (dummy
    // only) it resolves to the mock, preserving the existing flow exactly.
    const { intent, provider } = await this.orchestrator.createPayment(
      { currency: booking.currency, country: booking.event?.venue?.country ?? undefined },
      {
        bookingId,
        amountMinor: booking.totalMinor,
        currency: booking.currency,
        buyerEmail: booking.buyerEmail,
        idempotencyKey: booking.id,
      },
    );
    await this.prisma.payment.update({
      where: { bookingId },
      data: {
        status: PaymentStatus.PROCESSING,
        providerRef: intent.providerRef,
        // Record which gateway actually handled the intent (default 'mock').
        ...(provider ? { provider } : {}),
      },
    });
    return intent;
  }

  /**
   * Simulates the payment provider completing (or failing) a charge and calling
   * our webhook. Payment is NEVER confirmed from the browser redirect directly.
   */
  async mockPay(bookingId: string, outcome: 'succeeded' | 'failed') {
    if (!this.mockEnabled) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'Mock payments are disabled in this environment.',
        HttpStatus.FORBIDDEN,
      );
    }
    const payment = await this.prisma.payment.findUnique({ where: { bookingId } });
    if (!payment)
      throw new AppException(ErrorCodes.NOT_FOUND, 'Payment not found.', HttpStatus.NOT_FOUND);

    const event: PaymentEvent = {
      type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
      providerRef: payment.providerRef ?? `mock_pi_${randomBytes(8).toString('hex')}`,
      bookingId,
      amountMinor: payment.amountMinor,
    };
    // Dev-only: sign a synthetic event with the mock secret and feed it through
    // the normal webhook path. Guarded by mockEnabled above.
    const signed = this.mockProvider.signEvent(event);
    return this.handleWebhook(signed);
  }

  /** Public webhook entry point — verifies signature with the active provider. */
  async handleWebhook(input: WebhookInput) {
    const event = await this.provider.verifyWebhook(input);
    return this.processVerifiedEvent(event);
  }

  /**
   * Process an already-verified payment event (succeeded → confirm, else fail).
   * Used by the multi-provider webhook router after a provider-specific adapter
   * has verified the signature.
   */
  processVerifiedEvent(event: PaymentEvent) {
    if (event.type === 'payment.succeeded') {
      return this.confirm(event);
    }
    return this.fail(event);
  }

  private async confirm(event: PaymentEvent) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: event.bookingId },
      include: {
        items: true,
        event: { select: { experienceType: true, venue: { select: { country: true } } } },
      },
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
    // Only ticket-bearing lines issue tickets & settle ticket stock; add-on lines
    // (v1.3) settle their own inventory and never mint tickets.
    const ticketItems = booking.items.filter((i) => i.ticketTypeId);
    const addOnItems = booking.items.filter((i) => i.addOnId);
    const expectedUnits = ticketItems.reduce((s, i) => s + i.quantity, 0);
    let alreadyConfirmed = false;

    await this.prisma.$transaction(async (tx) => {
      // Atomic idempotency guard: only the delivery that flips PENDING_PAYMENT →
      // CONFIRMED issues tickets. Concurrent re-deliveries see count 0 and no-op,
      // so tickets can never be double-issued.
      const claim = await tx.booking.updateMany({
        where: { id: booking.id, status: BookingStatus.PENDING_PAYMENT },
        data: { status: BookingStatus.CONFIRMED, confirmedAt: new Date() },
      });
      if (claim.count !== 1) {
        alreadyConfirmed = true;
        return;
      }

      // Assign the immutable public reference in the same atomic step that flips
      // the booking to CONFIRMED — only ever the first delivery reaches here.
      const reference = await this.bookingReference.assign(tx, {
        country: booking.event.venue?.country,
        at: new Date(),
      });
      await tx.booking.update({ where: { id: booking.id }, data: { reference } });

      // Settle inventory (held → sold) via the experience's strategy, which returns
      // the exact tickets to issue (one per unit, or one per seat). See ADR-010/013.
      const specs = await strategy.confirm(tx, {
        eventSessionId: booking.eventSessionId,
        bookingId: booking.id,
        holdExpiresAt: booking.holdExpiresAt,
        lines: ticketItems.map((i) => ({
          ticketTypeId: i.ticketTypeId as string,
          quantity: i.quantity,
        })),
      });
      // Guard the "charged but hold expired → zero tickets" case: if the strategy
      // could not settle every booked unit, roll the whole confirm back.
      if (specs.length !== expectedUnits) {
        throw new AppException(
          ErrorCodes.BOOKING_INVENTORY_UNAVAILABLE,
          'This booking hold expired before payment settled and needs reconciliation.',
          HttpStatus.CONFLICT,
          { bookingId: booking.id },
        );
      }
      for (const spec of specs) {
        await tx.ticket.create({
          data: {
            bookingId: booking.id,
            ticketTypeId: spec.ticketTypeId,
            eventSessionId: booking.eventSessionId,
            organizationId: booking.organizationId,
            serial: serial(),
            nonce: nonce(),
            status: TicketStatus.ACTIVE,
            seatId: spec.seatId ?? null,
            seatLabel: spec.seatLabel ?? null,
            holderName: booking.buyerName,
            holderEmail: booking.buyerEmail,
          },
        });
      }
      // Settle add-on stock (held → sold) for this booking's add-on lines (v1.3).
      if (addOnItems.length > 0) {
        await this.addOnInventory.confirm(
          tx,
          addOnItems.map((i) => ({ addOnId: i.addOnId as string, quantity: i.quantity })),
        );
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
      if (booking.couponId) {
        await tx.coupon.update({
          where: { id: booking.couponId },
          data: { redemptions: { increment: 1 } },
        });
      }
    });

    if (alreadyConfirmed) {
      return { status: 'already_confirmed', bookingId: booking.id };
    }

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
    this.metrics.recordBookingConfirmed();
    this.metrics.recordPaymentSucceeded();
    this.metrics.recordGmv(booking.totalMinor);
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
    this.metrics.recordPaymentFailed();
    // The inventory hold stays until it expires, allowing the buyer to retry.
    return { status: 'failed', bookingId: booking.id };
  }
}
