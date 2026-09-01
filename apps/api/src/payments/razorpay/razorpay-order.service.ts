import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentAttemptStatus,
  PaymentStatus,
  type MarketplaceSplit,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppException, ErrorCodes } from '../../common/errors';
import type { RequestUser } from '../../common/decorators';
import { PaymentProviderResolver } from '../provider/payment-provider.resolver';

/** Booking shape the order flow needs (loaded by PaymentsService.createIntent). */
export interface RazorpayBookingContext {
  id: string;
  currency: string;
  totalMinor: number;
  buyerName: string;
  buyerEmail: string;
  userId: string | null;
}

/** Client-safe Razorpay Checkout payload (NEVER contains the key secret). */
export interface RazorpayCheckoutPayload {
  providerRef: string;
  clientActionUrl: string;
  status: 'REQUIRES_PAYMENT';
  provider: 'razorpay';
  razorpay: {
    keyId: string;
    orderId: string;
    amountMinor: number;
    currency: string;
    name: string;
    description: string;
    prefill: { name: string; email: string };
    callbackUrl: string;
  };
}

/**
 * India (Razorpay) customer payment flow: create a server-side Order, then verify the
 * synchronous Checkout signature. Charges land on the PLATFORM Razorpay account; the
 * organizer is paid later via Route at settlement (so checkout does NOT require an
 * organizer Linked Account). Tickets are issued ONLY by the authoritative webhook.
 */
@Injectable()
export class RazorpayOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PaymentProviderResolver,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** Create (or return the existing pending) Razorpay Order for an INR booking. */
  async createOrder(
    booking: RazorpayBookingContext,
    split: MarketplaceSplit,
    metadata: Record<string, string>,
  ): Promise<RazorpayCheckoutPayload> {
    const existing = await this.prisma.payment.findUnique({ where: { bookingId: booking.id } });
    // Retry-safe: a pending order already exists → return it, never a second payable order.
    if (existing?.providerOrderId && existing.status === PaymentStatus.PROCESSING) {
      return this.payload(existing.providerOrderId, booking);
    }

    const provider = this.resolver.get('razorpay');
    const intent = await provider.createPayment({
      bookingId: booking.id,
      amountMinor: booking.totalMinor,
      currency: booking.currency,
      buyerEmail: booking.buyerEmail,
      idempotencyKey: booking.id,
      metadata,
    });
    const orderId = intent.providerRef;

    await this.prisma.payment.update({
      where: { bookingId: booking.id },
      data: {
        status: PaymentStatus.PROCESSING,
        provider: 'razorpay',
        providerRef: orderId,
        providerOrderId: orderId,
        idempotencyKey: booking.id,
        subtotalMinor: split.subtotalMinor,
        taxMinor: split.taxMinor,
        platformFeeMinor: split.platformFeeMinor,
        organizerNetMinor: split.organizerNetMinor,
        metadata,
      },
    });

    return this.payload(orderId, booking);
  }

  /**
   * Verify the Razorpay Checkout success signature. Confirms the returned order matches
   * our stored order and the signature is valid; records the attempt. Idempotent and it
   * NEVER issues tickets — the signed webhook is the authoritative confirmation.
   */
  async verify(
    bookingId: string,
    body: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
    user?: RequestUser,
  ): Promise<{ status: 'processing' | 'confirmed'; bookingId: string }> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true },
    });
    if (!booking?.payment) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        'Booking/payment not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (booking.userId && user && booking.userId !== user.id && !isAdmin(user)) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        'You cannot verify this booking.',
        HttpStatus.FORBIDDEN,
      );
    }

    // Idempotent: already confirmed → nothing to do.
    if (booking.status === 'CONFIRMED') return { status: 'confirmed', bookingId };

    // The returned order id MUST match the one we created server-side.
    if (booking.payment.providerOrderId !== body.razorpay_order_id) {
      throw new AppException(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Razorpay order id does not match the stored order.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const provider = this.resolver.get('razorpay');
    const ok = provider.verifyCheckoutSignature?.({
      orderId: body.razorpay_order_id,
      paymentId: body.razorpay_payment_id,
      signature: body.razorpay_signature,
    });
    if (!ok) {
      await this.prisma.paymentAttempt.create({
        data: {
          paymentId: booking.payment.id,
          status: PaymentAttemptStatus.FAILED,
          providerRef: body.razorpay_payment_id,
        },
      });
      throw new AppException(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Invalid Razorpay payment signature.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Record the verified payment id (the webhook + refunds use it). Idempotent write.
    await this.prisma.payment.update({
      where: { bookingId },
      data: {
        providerPaymentIntentId: body.razorpay_payment_id,
        providerRef: body.razorpay_payment_id,
      },
    });
    await this.prisma.paymentAttempt.create({
      data: {
        paymentId: booking.payment.id,
        status: PaymentAttemptStatus.CREATED,
        providerRef: body.razorpay_payment_id,
      },
    });
    await this.audit.record({
      organizationId: booking.organizationId,
      action: 'RAZORPAY_CHECKOUT_VERIFIED',
      entityType: 'Payment',
      entityId: booking.payment.id,
      metadata: { orderId: body.razorpay_order_id },
    });

    // Do NOT issue tickets here — the webhook is authoritative.
    return { status: 'processing', bookingId };
  }

  private payload(orderId: string, booking: RazorpayBookingContext): RazorpayCheckoutPayload {
    return {
      providerRef: orderId,
      clientActionUrl: orderId,
      status: 'REQUIRES_PAYMENT',
      provider: 'razorpay',
      razorpay: {
        keyId: this.config.getOrThrow<string>('RAZORPAY_KEY_ID'),
        orderId,
        amountMinor: booking.totalMinor,
        currency: booking.currency,
        name: this.config.get<string>('RAZORPAY_CHECKOUT_NAME') ?? 'ETicketsGo',
        description:
          this.config.get<string>('RAZORPAY_CHECKOUT_DESCRIPTION') ?? 'Event ticket purchase',
        prefill: { name: booking.buyerName, email: booking.buyerEmail },
        callbackUrl: this.checkoutCallbackUrl(),
      },
    };
  }

  /**
   * Where Razorpay sends the buyer back after paying.
   *
   * ── WHY THIS IS DERIVED RATHER THAN ITS OWN VARIABLE ──────────────────────────────
   * `RAZORPAY_CALLBACK_URL` defaulted to `http://localhost:3000/checkout/razorpay/callback`,
   * and QA duly handed that to Razorpay the moment real keys were added: a customer who
   * paid would have been redirected to a machine that is not theirs, losing the
   * confirmation after the money moved. It failed silently, because a default is not a
   * missing value.
   *
   * That is the THIRD variable on this platform to ship a localhost default — the invite
   * links and the password-reset link were the first two. The pattern is the bug, so this
   * one is derived from the single place that already knows where the customer site lives,
   * and that one place fails loudly when it is unset. One fewer variable to forget.
   *
   * The explicit override remains for the case the derivation cannot cover: a callback
   * that must land somewhere other than the storefront.
   */
  private checkoutCallbackUrl(): string {
    const explicit = this.config.get<string>('RAZORPAY_CALLBACK_URL')?.trim();
    if (explicit) return explicit;

    const site = this.config.get<string>('CUSTOMER_WEB_URL')?.trim();
    if (site) return `${site.replace(/\/+$/, '')}/checkout/razorpay/callback`;

    const appEnv = this.config.get<string>('APP_ENV') ?? 'LOCAL';
    if (['LOCAL', 'DEV'].includes(appEnv)) {
      return 'http://localhost:3000/checkout/razorpay/callback';
    }
    throw new AppException(
      ErrorCodes.INTERNAL,
      'Cannot start a Razorpay payment: neither CUSTOMER_WEB_URL nor RAZORPAY_CALLBACK_URL is set, so the buyer would be returned to localhost after paying.',
      HttpStatus.INTERNAL_SERVER_ERROR,
      { appEnv },
    );
  }
}

function isAdmin(user: RequestUser): boolean {
  return user.roles.includes('ADMIN' as never) || user.roles.includes('SUPER_ADMIN' as never);
}
