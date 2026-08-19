import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import {
  BookingStatus,
  NotificationType,
  PaymentAttemptStatus,
  PaymentStatus,
  TicketStatus,
  computeMarketplaceSplit,
  routeProviderForBooking,
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
import { isDummyAllowed, resolvePaymentEnv } from './configuration/payment-environment';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';
import { BookingReferenceService } from '../bookings/booking-reference.service';
import { SettlementService } from './settlement/settlement.service';
import { RazorpayOrderService } from './razorpay/razorpay-order.service';
import {
  type DomainEvent,
  bookingConfirmedEvent,
  TransactionalEventPublisher,
} from '../common/domain-events';
import { BookingConfirmationBridge } from '../bookings/orchestration/booking-confirmation-bridge';

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
    private readonly config: ConfigService,
    private readonly settlements: SettlementService,
    private readonly razorpayOrders: RazorpayOrderService,
    // Transaction-aware publisher (ADR-038/041). In outbox mode it records the
    // BookingConfirmed fact durably inside the confirm transaction; in in_process mode
    // it delivers post-commit. This is the single domain-event path for confirmation.
    private readonly eventPublisher: TransactionalEventPublisher,
    // One-way bridge to the booking orchestrator (ADR-042 P5.2A). After a confirmed
    // webhook commits, advances the durable BookingWorkflow. No-op unless a workflow
    // exists (active mode); never affects the confirmation result.
    private readonly bookingBridge: BookingConfirmationBridge,
  ) {}

  private readonly logger = new Logger(PaymentsService.name);

  /** Whether the active provider is a Connect marketplace (Stripe implements transfers). */
  private get isMarketplaceProvider(): boolean {
    return typeof this.provider.createTransfer === 'function';
  }

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

  /**
   * Whether the mock "simulate payment" path is allowed.
   *
   * ── WHY NOT NODE_ENV ──────────────────────────────────────────────────────────────
   * This used to read `NODE_ENV !== 'production'`, which conflates "built for production"
   * with "IS the production environment". Every deployed environment runs a production
   * build, so QA — which deliberately runs the simulated gateway — had mock payments
   * refused. Checkout handed the browser a `mock-pay` URL and the server then answered 403
   * "Mock payments are disabled in this environment": NO booking could be paid on QA at
   * all, and the buyer was told "Payment could not be completed. Please try again."
   *
   * `APP_ENV` is the question actually being asked, and `isDummyAllowed` already answers it
   * for the rest of the payment module (LOCAL/DEV/QA). Using it here means one source of
   * truth rather than two that disagree.
   *
   * ── STILL FAIL-CLOSED ─────────────────────────────────────────────────────────────
   * Both conditions must hold, so this is TIGHTER than the old check, not looser:
   *   - the environment permits a simulated gateway at all, and
   *   - the active gateway really is the mock.
   * A production box that forgot to set APP_ENV would fall back to LOCAL on the first
   * condition, but its PAYMENT_PROVIDER_NAME is a real gateway, so the second still refuses.
   * `PAYMENTS_MOCK_ENABLED=false` remains an explicit kill switch.
   */
  private readonly mockEnabled =
    process.env.PAYMENTS_MOCK_ENABLED !== 'false' &&
    isDummyAllowed(resolvePaymentEnv(process.env.APP_ENV)) &&
    (process.env.PAYMENT_PROVIDER_NAME ?? 'mock') === 'mock';

  /** Create a payment intent for a pending booking (owner or platform admin only). */
  async createIntent(bookingId: string, user?: RequestUser) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        payment: true,
        // organizationId → connected account; country feeds payment routing.
        event: { select: { organizationId: true, venue: { select: { country: true } } } },
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

    // Marketplace split (integer minor units) from the booking's snapshot. The customer
    // pays booking.totalMinor; the organizer's proceeds and ETicketsGo's platform fee are
    // recorded now and settled after the event (Separate Charges & Transfers).
    const split = computeMarketplaceSplit({
      subtotalMinor: booking.subtotalMinor,
      organizerFeeMinor: booking.organizerFeeMinor,
      discountMinor: booking.discountMinor,
      totalMinor: booking.totalMinor,
    });
    const organizationId = booking.event?.organizationId;

    // Safe, non-sensitive metadata only.
    const metadata: Record<string, string> = {
      eventId: booking.eventId,
      organizerId: organizationId ?? '',
      customerId: booking.userId ?? 'guest',
      environment: this.config.get<string>('APP_ENV') ?? 'LOCAL',
    };

    // ─── India (Razorpay) branch ───
    // Route by TRUSTED business data (currency), never a client-supplied provider. When
    // INR is routed to Razorpay AND Razorpay is configured, delegate to the Order flow
    // (client-side Checkout). The Stripe/mock path below is left EXACTLY as-is otherwise,
    // so dev/e2e (INR + mock, no Razorpay keys) and the US Stripe flow are unaffected.
    if (
      routeProviderForBooking({
        currency: booking.currency,
        country: booking.event?.venue?.country,
      }) === 'razorpay' &&
      this.config.get<string>('RAZORPAY_KEY_ID')
    ) {
      return this.razorpayOrders.createOrder(
        {
          id: booking.id,
          currency: booking.currency,
          totalMinor: booking.totalMinor,
          buyerName: booking.buyerName,
          buyerEmail: booking.buyerEmail,
          userId: booking.userId,
        },
        split,
        metadata,
      );
    }

    // For a Connect provider (Stripe) a paid booking requires the organizer to have a
    // charges-enabled connected account — otherwise there is nowhere to settle proceeds.
    // Non-Connect providers (mock/dev) skip this gate, preserving the existing flow.
    let connectedAccountId: string | undefined;
    if (this.isMarketplaceProvider && booking.totalMinor > 0 && organizationId) {
      const account = await this.prisma.organizerPaymentAccount.findUnique({
        where: { organizationId_provider: { organizationId, provider: this.provider.name } },
      });
      if (!account?.providerAccountId || !account.chargesEnabled) {
        throw new AppException(
          ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
          'This organizer has not finished payment setup yet and cannot accept payments.',
          HttpStatus.CONFLICT,
          { organizationId },
        );
      }
      connectedAccountId = account.providerAccountId;
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
        // Marketplace (ignored by non-Connect providers). The charge stays on the
        // platform; transferGroup links it to the post-event settlement transfer.
        ...(connectedAccountId
          ? {
              connectedAccountId,
              platformFeeAmountMinor: split.platformFeeMinor,
              transferGroup: `etg_event_${booking.eventId}`,
            }
          : {}),
        metadata,
      },
    );
    await this.prisma.payment.update({
      where: { bookingId },
      data: {
        status: PaymentStatus.PROCESSING,
        providerRef: intent.providerRef,
        // Record which gateway actually handled the intent (default 'mock').
        ...(provider ? { provider } : {}),
        // Snapshot the split + Connect linkage for reconciliation and settlement.
        providerPaymentIntentId: intent.providerRef,
        connectedAccountId: connectedAccountId ?? null,
        idempotencyKey: booking.id,
        subtotalMinor: split.subtotalMinor,
        taxMinor: split.taxMinor,
        platformFeeMinor: split.platformFeeMinor,
        organizerNetMinor: split.organizerNetMinor,
        metadata,
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
  async processVerifiedEvent(event: PaymentEvent) {
    if (event.type === 'payment.succeeded') {
      // ADR-042 §10 (P5.2B S3): give a PROVIDER_AUTHORITATIVE workflow the chance to own
      // confirmation (provider-confirm BEFORE local-confirm). If it handles the event, the
      // default local confirm below is skipped. Local/allocated bookings decline and proceed
      // unchanged. Flag-off ⇒ no handler ⇒ unchanged behaviour.
      const pre = await this.bookingBridge.preConfirm({
        bookingId: event.bookingId,
        providerRef: event.providerRef,
        amountMinor: event.amountMinor,
      });
      if (pre.handled) return pre.result;

      const result = await this.confirm(event);
      // ADR-042 P5.2A: reconcile the durable booking workflow to CONFIRMED (active mode
      // only — no-op when no workflow exists). Runs AFTER the atomic confirm commits and
      // never changes the confirmation result.
      const status = (result as { status?: string }).status;
      if (status === 'confirmed' || status === 'already_confirmed') {
        await this.bookingBridge.onConfirmed(event.bookingId);
      }
      return result;
    }
    return this.fail(event);
  }

  /**
   * The atomic local confirmation (inventory settle + booking confirm + outbox), reused by
   * the provider-authoritative flow AFTER external provider confirmation succeeds (ADR-042
   * §10). Identical semantics + `alreadyConfirmed` idempotency to the webhook path; it does
   * NOT re-run the provider pre-confirm hook, so there is no recursion.
   */
  confirmVerifiedLocal(event: PaymentEvent) {
    return this.confirm(event);
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

    // Security: the browser redirect is never trusted, and even a signed webhook must
    // pay the exact booked amount. If the provider-reported amount does not match the
    // server-side total, refuse to issue tickets and flag it for reconciliation.
    if (event.amountMinor !== booking.totalMinor) {
      await this.audit.record({
        organizationId: booking.organizationId,
        action: 'PAYMENT_AMOUNT_MISMATCH',
        entityType: 'Booking',
        entityId: booking.id,
        metadata: {
          expectedMinor: booking.totalMinor,
          receivedMinor: event.amountMinor,
          providerRef: event.providerRef,
        },
      });
      throw new AppException(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        `Paid amount ${event.amountMinor} does not match booking total ${booking.totalMinor}.`,
        HttpStatus.CONFLICT,
        { bookingId: booking.id },
      );
    }

    const strategy = this.inventory.forExperienceType(booking.event.experienceType);
    // Only ticket-bearing lines issue tickets & settle ticket stock; add-on lines
    // (v1.3) settle their own inventory and never mint tickets.
    const ticketItems = booking.items.filter((i) => i.ticketTypeId);
    const addOnItems = booking.items.filter((i) => i.addOnId);
    const expectedUnits = ticketItems.reduce((s, i) => s + i.quantity, 0);
    const ticketCount = booking.items.reduce((s, i) => s + i.quantity, 0);
    let alreadyConfirmed = false;
    // The BookingConfirmed fact, built + durably recorded inside the confirm tx (ADR-041).
    let confirmedEvent: DomainEvent | null = null;

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
        data: {
          status: PaymentStatus.SUCCEEDED,
          providerRef: event.providerRef,
          providerPaymentIntentId: event.providerRef,
          paidAt: new Date(),
        },
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

      // ADR-041 proof slice: build the BookingConfirmed fact and record it DURABLY in
      // the SAME transaction (outbox modes). Only the first delivery reaches here, so
      // exactly one outbox row is ever written. In in_process mode this is a no-op and
      // delivery stays post-commit (unchanged P2 behaviour). If the outbox insert fails
      // the whole confirm transaction rolls back (required-event semantics).
      confirmedEvent = bookingConfirmedEvent({
        bookingId: booking.id,
        userId: booking.userId ?? 'guest',
        experienceId: booking.eventId,
        showId: booking.eventSessionId,
        amount: String(booking.totalMinor),
        currency: booking.currency,
        ticketCount,
        confirmedAt: new Date().toISOString(),
      });
      await this.eventPublisher.recordInTransaction(tx, [confirmedEvent]);
    });

    if (alreadyConfirmed) {
      return { status: 'already_confirmed', bookingId: booking.id };
    }

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
    // Accrue the organizer's proceeds into the event's settlement ledger (best-effort;
    // the event-completion sweep and admin view both re-sync).
    void this.settlements.onPaymentSucceeded(booking.eventId);

    // Deliver the BookingConfirmed fact AFTER commit (ADR-041). Mode-aware: in_process
    // and dual_write_shadow publish directly (unchanged P2 behaviour); outbox mode is a
    // no-op here because the durable row recorded in-tx is delivered by the dispatcher —
    // exactly one production delivery path. Fully isolated from booking correctness.
    if (confirmedEvent) {
      try {
        await this.eventPublisher.deliverAfterCommit([confirmedEvent]);
      } catch {
        this.logger.error(`BookingConfirmed domain event delivery failed for ${booking.id}`);
      }
    }
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
