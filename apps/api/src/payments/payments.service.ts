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
import { PaymentProviderResolver } from './provider/payment-provider.resolver';
import { AppException, ErrorCodes } from '../common/errors';
import { isDummyAllowed, resolvePaymentEnv } from './configuration/payment-environment';
import type { RequestUser } from '../common/decorators';
import { MetricsService } from '../metrics/metrics.service';
import { ReceiptsService } from '../receipts/receipts.service';
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
    // Resolves an adapter BY NAME. The marketplace gate needs the provider this booking
    // will actually use, which the globally injected one above is not.
    private readonly resolver: PaymentProviderResolver,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly inventory: InventoryService,
    private readonly addOnInventory: AddOnInventoryService,
    private readonly metrics: MetricsService,
    private readonly bookingReference: BookingReferenceService,
    private readonly receipts: ReceiptsService,
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

  /**
   * Whether the provider THIS BOOKING will use is a Connect marketplace.
   *
   * ── WHY THIS TAKES A BOOKING AND NOT NOTHING ───────────────────────────────────────
   * It used to ask the globally configured provider, which is `mock` in every environment
   * that has not set the global switch. So the marketplace gate below — the one refusing a
   * paid booking whose organizer has no charges-enabled account — was skipped entirely,
   * and a USD booking would have gone to Stripe with no `connectedAccountId` and no
   * `transferGroup`. The charge would succeed and land on the platform with nothing tying
   * it to the organizer it was collected for, which is the sort of thing discovered at
   * settlement.
   *
   * Routing is per booking, from its currency. USD goes to Stripe whatever the global
   * switch says, so the capability question has to be asked of the provider that will
   * actually take the money.
   */
  private marketplaceProviderFor(booking: {
    currency: string;
    event?: { venue?: { country?: string | null } | null } | null;
  }): { name: string; provider: PaymentProvider } | null {
    const name = routeProviderForBooking({
      currency: booking.currency,
      country: booking.event?.venue?.country,
    });
    if (!name) return null;
    let provider: PaymentProvider;
    try {
      provider = this.resolver.get(name);
    } catch {
      // Not configured in this environment — the orchestrator below will decide what to do
      // about that, and it gives a better message than a capability check can.
      return null;
    }
    return typeof provider.createTransfer === 'function' ? { name, provider } : null;
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
        event: {
          select: { organizationId: true, isFree: true, venue: { select: { country: true } } },
        },
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

    /*
      A free event never reaches a payment provider, and this is where that is made structural
      rather than merely true by convention.

      The booking path confirms free bookings on the spot, so in practice one is CONFIRMED
      before anything could call this and the check above already refused it. This is the
      backstop for the case that survives a partial failure: a free booking left PENDING_PAYMENT
      because confirmation errored. Without this it would fall through to the routing below and
      open a zero-rupee Razorpay order — the exact call the whole feature exists to avoid.
    */
    if (booking.event?.isFree) {
      throw new AppException(
        ErrorCodes.BOOKING_NOT_PAYABLE,
        'This event is free. There is nothing to pay.',
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
    const marketplace = this.marketplaceProviderFor(booking);
    if (marketplace && booking.totalMinor > 0 && organizationId) {
      const account = await this.prisma.organizerPaymentAccount.findUnique({
        // Keyed on the provider that will TAKE this payment, not on whichever one is
        // globally configured — an account onboarded with Stripe is not a Razorpay account.
        where: { organizationId_provider: { organizationId, provider: marketplace.name } },
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

  /**
   * Confirm a booking that costs nothing, without involving a payment provider.
   *
   * ── WHY NOT A ZERO-AMOUNT CHARGE ───────────────────────────────────────────────
   * Sending a gateway a request to collect ₹0 is a support ticket waiting to happen: some
   * providers reject it, some accept and settle nothing, all of them put a row in a
   * reconciliation report that will never balance against anything. A free event has no
   * money in it, so it has no payment in it either — no Payment row, no REQUIRES_PAYMENT
   * state, no provider call.
   *
   * ── THE GUARD THAT MATTERS ─────────────────────────────────────────────────────
   * This method confirms a booking WITHOUT anybody paying, so the one thing it must never
   * do is confirm a booking that somebody owes money on. The total is re-read from the
   * database — not taken from the caller — and anything but zero is refused outright. A
   * bug elsewhere that routed a priced booking here would otherwise hand out free tickets.
   */
  /**
   * Record that cash was handed over at the venue, and confirm the booking.
   *
   * ── WHY THIS IS A SEPARATE ENTRY POINT ─────────────────────────────────────────────
   * Every other confirmation is caused by a provider telling us money moved. This one is
   * caused by a person saying so. There is no webhook to verify, no signature, and no way
   * to check the claim afterwards — which is exactly why it is deliberately narrow: it
   * confirms the FULL amount the booking already says is owed, it records WHO said so, and
   * it refuses anything that is not a cash booking awaiting collection.
   *
   * The amount is not a parameter. Letting the caller pass one would make partial payment
   * expressible, and a half-paid booking is a state with no defined meaning here — the
   * ticket either admits somebody or it does not.
   */
  async collectCash(bookingId: string, collectorUserId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        paymentMethod: true,
        totalMinor: true,
        organizationId: true,
        cashCollectedAt: true,
      },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    if (booking.paymentMethod !== 'CASH') {
      /*
        Refused rather than quietly allowed. Marking an ONLINE booking as cash-collected
        would confirm a ticket nobody paid for through any channel we can see, and it would
        be invisible afterwards because there is no provider record to contradict it.
      */
      throw new AppException(
        ErrorCodes.BOOKING_NOT_PAYABLE,
        'This booking is not a cash booking. It is paid online.',
        HttpStatus.CONFLICT,
      );
    }
    if (booking.status === 'CONFIRMED' && booking.cashCollectedAt) {
      // Idempotent: two staff pressing the same button must not double-issue tickets.
      return { status: 'already_collected' as const, bookingId };
    }
    if (booking.status !== 'PENDING_PAYMENT') {
      throw new AppException(
        ErrorCodes.BOOKING_NOT_PAYABLE,
        `This booking is ${booking.status.toLowerCase().replace(/_/g, ' ')} and cannot be collected.`,
        HttpStatus.CONFLICT,
      );
    }

    /*
      Stamped BEFORE confirming, and conditionally on it still being uncollected.

      Two people at the same counter can press Collect at the same moment. This update is
      the race winner's proof: `count === 0` means somebody else got there first, and the
      loser must not go on to issue a second set of tickets.
    */
    const claimed = await this.prisma.booking.updateMany({
      where: { id: bookingId, cashCollectedAt: null, paymentMethod: 'CASH' },
      data: { cashCollectedAt: new Date(), cashCollectedByUserId: collectorUserId },
    });
    if (claimed.count === 0) {
      return { status: 'already_collected' as const, bookingId };
    }

    await this.audit.record({
      actorUserId: collectorUserId,
      organizationId: booking.organizationId,
      action: 'CASH_COLLECTED',
      entityType: 'Booking',
      entityId: booking.id,
      metadata: { amountMinor: booking.totalMinor },
    });

    /*
      The amount check stays on. `providerRef` records how this was confirmed so a later
      reader of the Booking is never left guessing why there is no provider reference.
    */
    return this.confirm(
      {
        type: 'payment.succeeded',
        providerRef: `cash:${bookingId}`,
        bookingId,
        amountMinor: booking.totalMinor,
      },
      { withoutPayment: true },
    );
  }

  async confirmFreeBooking(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, totalMinor: true, organizationId: true },
    });
    if (!booking) {
      throw new AppException(ErrorCodes.NOT_FOUND, 'Booking not found.', HttpStatus.NOT_FOUND);
    }
    if (booking.totalMinor !== 0) {
      await this.audit.record({
        organizationId: booking.organizationId,
        action: 'FREE_CONFIRM_REFUSED',
        entityType: 'Booking',
        entityId: booking.id,
        metadata: { totalMinor: booking.totalMinor },
      });
      throw new AppException(
        ErrorCodes.BOOKING_NOT_PAYABLE,
        'This booking has an amount to pay and cannot be confirmed as free.',
        HttpStatus.CONFLICT,
        { totalMinor: booking.totalMinor },
      );
    }
    return this.confirm(
      { type: 'payment.succeeded', providerRef: `free:${bookingId}`, bookingId, amountMinor: 0 },
      { withoutPayment: true, skipAmountCheck: true },
    );
  }

  /**
   * @param options.withoutPayment A booking with NO Payment row: nothing to settle, and
   *   no provider amount to reconcile against. True for two quite different cases — a free
   *   booking, where no money exists, and a cash booking, where money exists but never
   *   passed through the platform. Everything else — the reference, the receipt, inventory
   *   settlement, ticket issue, the domain event, the notification — is identical, because
   *   none of it is about who held the money.
   * @param options.skipAmountCheck Only for free bookings, where there is no provider
   *   figure to agree with. Cash deliberately keeps the check: the collector confirms a
   *   specific amount, and it must equal what the booking says is owed.
   */
  private async confirm(
    event: PaymentEvent,
    options: { withoutPayment?: boolean; skipAmountCheck?: boolean } = {},
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: event.bookingId },
      include: {
        items: true,
        // `title` and the session start are read only so the confirmation notification can
        // name what the customer is going to, instead of quoting a database id at them.
        event: {
          select: {
            title: true,
            experienceType: true,
            venue: { select: { country: true, timezone: true } },
          },
        },
        // The screen's cinema carries the timezone. A showtime means the time AT THE
        // CINEMA, so that is what a confirmation has to quote — not the server's zone and
        // not the reader's.
        eventSession: {
          select: {
            startsAt: true,
            screen: { select: { cinema: { select: { timezone: true } } } },
          },
        },
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
    //
    // A free booking has no provider to disagree with. Its equivalent guard already ran in
    // `confirmFreeBooking`, which re-read the total from the database and refuses anything
    // but zero — so the money check has been made, just not against a gateway.
    if (!options.skipAmountCheck && event.amountMinor !== booking.totalMinor) {
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

    /*
      The booking's OWN seating, not its event's kind.

      Confirmation has to settle inventory the same way the hold took it. Re-deriving that
      from the experience type would settle a seated concert as a counter — and re-deriving
      it from the session would follow the session if it were ever edited afterwards, which
      is why the decision is stored on the booking when it is made.
    */
    const strategy = this.inventory.forSeating(booking.seatBased);
    // Only ticket-bearing lines issue tickets & settle ticket stock; add-on lines
    // (v1.3) settle their own inventory and never mint tickets.
    const ticketItems = booking.items.filter((i) => i.ticketTypeId);
    const addOnItems = booking.items.filter((i) => i.addOnId);
    const expectedUnits = ticketItems.reduce((s, i) => s + i.quantity, 0);
    const ticketCount = booking.items.reduce((s, i) => s + i.quantity, 0);
    let alreadyConfirmed = false;
    // Captured out of the transaction so the notification can name the booking the way the
    // customer sees it, rather than by its database id.
    let assignedReference: string | null = null;
    // Collected as the tickets are minted, rather than read back afterwards: the seat labels
    // are already in hand at that point, and a second query would be asking the database to
    // repeat something this method just decided.
    let issuedSeatLabels: string[] = [];
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
      assignedReference = reference;
      await tx.booking.update({ where: { id: booking.id }, data: { reference } });

      // Issue the receipt (or tax invoice) in the SAME transaction that confirms the
      // booking, so "the customer was charged" and "the customer has a document for it"
      // cannot come apart. Issuing afterwards would leave a window — and, on a crash, a
      // permanent gap — where money moved and nothing recorded it.
      await this.receipts.issueForBooking(tx, booking.id);

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
      issuedSeatLabels = specs
        .map((spec) => spec.seatLabel)
        .filter((l): l is string => Boolean(l))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

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
      /*
        A free or cash booking has no Payment row to settle, and must not acquire one.

        Writing a zero-amount SUCCEEDED payment would put a line in every reconciliation,
        settlement and payout report that can never balance against a bank statement,
        because no bank was involved. `where: { bookingId }` would fail outright anyway —
        the row was never created.
      */
      if (!options.withoutPayment) {
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
      }
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

    /*
      What the customer is actually told.

      Reported from QA: the confirmation read "Your booking cmt83vftr007l912we33eldkp is
      confirmed for 2 ticket(s)." A cuid is a database identity; it means nothing to the
      person who bought the ticket, cannot be read aloud to support, and is not what is
      printed on their receipt or their booking reference.

      So the payload now carries the things a human recognises — the reference, what they are
      going to, and when. The id is still included as a fallback for the rare case where a
      reference could not be assigned, but it is no longer the headline.
    */
    await this.notifications.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId: booking.userId,
      toEmail: booking.buyerEmail,
      payload: {
        bookingId: booking.id,
        reference: assignedReference ?? booking.reference ?? '',
        eventTitle: booking.event?.title ?? '',
        startsAt: booking.eventSession?.startsAt?.toISOString() ?? '',
        // Cinema first, then the venue. Without the fallback every non-cinema event fell
        // back to UTC in the confirmation while the page showed the reader's own zone.
        timeZone:
          booking.eventSession?.screen?.cinema?.timezone ?? booking.event?.venue?.timezone ?? '',
        seats: issuedSeatLabels.join(', '),
        tickets: ticketCount,
      },
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
