import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';
import { razorpayFailureReason } from '@eticketsgo/shared-types';
import { AppException, ErrorCodes } from '../../common/errors';
import type {
  CheckoutVerifyInput,
  ConnectedAccountSnapshot,
  CreatePaymentInput,
  HealthCheckResult,
  PaymentEvent,
  PaymentIntent,
  PaymentProvider,
  PaymentStatusResult,
  RefundInput,
  RefundResult,
  TransferInput,
  TransferOutcome,
  TransferReversalInput,
  ReversalOutcome,
  TransferReversalState,
  WebhookEnvelope,
  WebhookInput,
} from './payment-provider.interface';
import { PaymentMethod, type PaymentProviderCapabilities } from '../domain/payment-capabilities';
import { razorpayReversalFailure, razorpayTransferFailure } from './reversal-outcome';

/** Shape of the Razorpay webhook JSON we consume (only the fields we read). */
interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        notes?: Record<string, string | number> | null;
        error_code?: string | null;
        error_reason?: string | null;
        error_source?: string | null;
        error_step?: string | null;
      };
    };
    order?: {
      entity?: { id?: string; receipt?: string; notes?: Record<string, string | number> | null };
    };
  };
}

/**
 * Razorpay (India) provider. Charges happen client-side via Razorpay Checkout
 * using the Order we create here; settlement is confirmed only via the signed
 * `payment.captured` webhook (never trusted from the browser).
 *
 * Sandbox vs production is purely a matter of test vs live API keys — same code.
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay';
  readonly webhookSignatureHeader = 'x-razorpay-signature';
  readonly capabilities: PaymentProviderCapabilities = {
    countries: ['IN'],
    currencies: ['INR'],
    paymentMethods: [
      PaymentMethod.CARD,
      PaymentMethod.UPI,
      PaymentMethod.NETBANKING,
      PaymentMethod.WALLET,
    ],
    supportsPartialRefunds: true,
    supportsMultiplePartialRefunds: true,
    supportsAuthorizeCapture: false,
    supportsVoid: false,
    supportsIdempotentVoid: false,
    supportsPaymentStatusQuery: true,
    supportsFullRefund: true,
    supportsIdempotentRefund: false,
    /*
      FALSE: this adapter implements `refund` and `getPayment`, but no `getRefund`. The
      declaration said otherwise, which the capability-honesty check caught.

      Nothing was broken by it - `payment-refund.executor` guards on BOTH the capability and the
      method, and falls back to manual review - but a capability that overstates its adapter is
      the thing the model exists to prevent, and the next caller might trust it alone.
    */
    supportsRefundStatusQuery: false,
    refundMayBeAsynchronous: true,
    supportsIdempotentTransfer: false,
    supportsTransferStatusQuery: false,
    supportsConnectedAccounts: true,
    supportsApplePay: false,
    supportsGooglePay: true,
    supportsUPI: true,
    supportsNetBanking: true,
    supportsWallets: true,
  };

  private readonly client: Razorpay;
  private readonly webhookSecret: string;
  private readonly keySecret: string;
  private readonly testMode: boolean;
  private readonly routeEnabled: boolean;

  constructor(config: ConfigService) {
    const keyId = requireKey(config, 'RAZORPAY_KEY_ID');
    this.keySecret = requireKey(config, 'RAZORPAY_KEY_SECRET');
    this.webhookSecret = requireKey(config, 'RAZORPAY_WEBHOOK_SECRET');
    this.testMode = keyId.startsWith('rzp_test_');
    this.routeEnabled = config.get<boolean>('RAZORPAY_ROUTE_ENABLED') ?? false;
    this.client = new Razorpay({ key_id: keyId, key_secret: this.keySecret });
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const mode = this.testMode ? 'test' : 'live';
    try {
      // A cheap authenticated read; throws on bad credentials/connectivity.
      await this.client.orders.all({ count: 1 });
      return { healthy: true, mode };
    } catch (err) {
      return { healthy: false, mode, message: err instanceof Error ? err.message : 'unhealthy' };
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentIntent> {
    // Razorpay amounts are in the currency subunit, same as our amountMinor.
    // `receipt` (bookingId) is our idempotent business key; `notes.bookingId`
    // travels through Checkout onto the payment entity so the webhook can
    // resolve the booking without an extra API round-trip.
    const order = await this.client.orders.create({
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.bookingId,
      // Safe internal identifiers only — NEVER buyer PII (email/name/phone) in notes.
      notes: {
        bookingId: input.bookingId,
        ...(input.metadata?.eventId ? { eventId: input.metadata.eventId } : {}),
        ...(input.metadata?.organizerId ? { organizerId: input.metadata.organizerId } : {}),
      },
    });

    return {
      // Frontend Razorpay Checkout opens with { key: RAZORPAY_KEY_ID, order_id }.
      providerRef: order.id,
      clientActionUrl: order.id,
      status: 'REQUIRES_PAYMENT',
    };
  }

  async verifyWebhook(input: WebhookInput): Promise<PaymentEvent> {
    // HMAC-SHA256 of the raw body with the webhook secret, timing-safe compared
    // to the x-razorpay-signature header value.
    const expected = createHmac('sha256', this.webhookSecret).update(input.rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature ?? '');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppException(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Invalid webhook signature.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const body = JSON.parse(input.rawBody) as RazorpayWebhookBody;
    const type = this.mapEventType(body.event);
    const entity = body.payload?.payment?.entity;
    const bookingId = this.resolveBookingId(body);
    const amountMinor = entity?.amount;

    if (!bookingId || typeof amountMinor !== 'number') {
      throw new AppException(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Webhook payload is missing bookingId or amount.',
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      type,
      // The payment id is what refund() needs later, so surface it as providerRef.
      providerRef: entity?.id ?? body.payload?.order?.entity?.id ?? bookingId,
      bookingId,
      amountMinor,
      ...(type === 'payment.failed'
        ? {
            failure: {
              reason: razorpayFailureReason({
                code: entity?.error_code,
                reason: entity?.error_reason,
                source: entity?.error_source,
                step: entity?.error_step,
              }),
              providerCode: entity?.error_reason ?? entity?.error_code ?? null,
            },
          }
        : {}),
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const refund = await this.client.payments.refund(input.providerRef, {
      amount: input.amountMinor,
      notes: input.reason ? { reason: input.reason } : {},
    });
    /*
      Only `processed` means the money went back. A Razorpay refund is normally `pending` when
      created and is settled later — reported by `refund.processed` or `refund.failed` — so
      calling a pending refund COMPLETED told the customer, the credit note and the books that
      money had moved when Razorpay could still fail it.
    */
    return {
      providerRef: refund.id,
      status:
        refund.status === 'processed'
          ? 'COMPLETED'
          : refund.status === 'failed'
            ? 'FAILED'
            : 'PROCESSING',
    };
  }

  /**
   * Verify a Razorpay Checkout success signature: HMAC-SHA256 of "order_id|payment_id"
   * keyed by the API key secret, timing-safe compared to razorpay_signature. This is the
   * synchronous integrity check; the signed webhook remains the authoritative confirmation.
   */
  verifyCheckoutSignature(input: CheckoutVerifyInput): boolean {
    const expected = createHmac('sha256', this.keySecret)
      .update(`${input.orderId}|${input.paymentId}`)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature ?? '');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Every payment Razorpay holds against an order — the recovery lookup.
   *
   * `orders.fetchPayments` is answerable from the order id alone, which is all we have
   * before a webhook lands. Errors are deliberately NOT swallowed into an empty list: the
   * caller must be able to tell "Razorpay says nobody paid" from "Razorpay did not answer",
   * and an empty array would make a timeout look like an abandoned cart.
   */
  async findOrderPayments(orderId: string): Promise<PaymentStatusResult[]> {
    const res = await this.client.orders.fetchPayments(orderId);
    return (res.items ?? []).map((p) => ({
      providerRef: String(p.id),
      status: mapPaymentStatus(String(p.status)),
      amountMinor: Number(p.amount),
      currency: String(p.currency),
    }));
  }

  /** Fetch a payment's current authoritative state (used by the verify endpoint + reconcile). */
  async getPayment(providerRef: string): Promise<PaymentStatusResult> {
    const p = await this.client.payments.fetch(providerRef);
    return {
      providerRef: p.id,
      status: mapPaymentStatus(String(p.status)),
      amountMinor: Number(p.amount),
      currency: String(p.currency),
    };
  }

  /**
   * Verify the webhook signature against the RAW body and normalize the full event for
   * the durable pipeline. Razorpay bodies carry no globally-unique event id, so `id` is
   * left empty — the ingest service derives a stable dedup key from type + entity + hash.
   */
  verifySignedEnvelope(input: WebhookInput): WebhookEnvelope {
    const expected = createHmac('sha256', this.webhookSecret).update(input.rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature ?? '');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppException(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Invalid webhook signature.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const body = JSON.parse(input.rawBody) as {
      event?: string;
      created_at?: number;
      payload?: unknown;
      account_id?: string;
    };
    return {
      id: '',
      type: body.event ?? 'unknown',
      createdAt: body.created_at ?? 0,
      account: body.account_id ?? null,
      object: body.payload ?? {},
    };
  }

  // ─── Route (marketplace transfers to Linked Accounts) ───

  async createTransfer(input: TransferInput): Promise<TransferOutcome> {
    if (!this.routeEnabled) {
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Razorpay Route is not enabled (RAZORPAY_ROUTE_ENABLED=false).',
        HttpStatus.CONFLICT,
      );
    }
    try {
      const transfer = await this.client.transfers.create({
        account: input.destinationAccountId,
        amount: input.amountMinor,
        currency: input.currency.toUpperCase(),
        ...(input.metadata ? { notes: input.metadata } : {}),
      });
      /*
        ACCEPTED, not COMPLETED. A successful `transfers.create` proves Razorpay took the
        instruction. It does not prove the organizer has the money.
      */
      return { kind: 'ACCEPTED', transferId: transfer.id, raw: { id: transfer.id } };
    } catch (err) {
      /*
        Always INDETERMINATE, and that is a statement about our evidence rather than about
        Razorpay. Its error taxonomy for Route is not evidenced anywhere here, so a refusal and
        a timeout are indistinguishable - and the costs are not symmetric. See
        `razorpayTransferFailure`.
      */
      return razorpayTransferFailure(err);
    }
  }

  /**
   * Reverse a transfer, reporting only what Razorpay's answer proves.
   *
   * ── WHY THIS NEVER RETURNS CONFIRMED ───────────────────────────────────────────
   * `RazorpayReversal` carries `id`, `transfer_id`, `amount`, `currency` and `created_at` - and
   * NO status field, and nothing equivalent to Stripe's `balance_transaction`. So a successful
   * call proves Razorpay ACCEPTED the operation and gave us a reference. It does not prove the
   * money came back.
   *
   * This used to return a hardcoded `COMPLETED`, which wrote "money recovered" into the ledger
   * on the strength of a response that cannot say so.
   *
   * Completion arrives later, from the `transfer.reversed` webhook or from reconciliation
   * reading the transfer's cumulative `amount_reversed`, which IS authoritative. That is why not
   * knowing whether Route reversals are synchronous does not block this: we never depended on
   * the synchronous answer to prove completion.
   */
  async reverseTransfer(input: TransferReversalInput): Promise<ReversalOutcome> {
    if (input.amountMinor == null) {
      throw new AppException(
        ErrorCodes.VALIDATION_FAILED,
        'Razorpay transfer reversals require an explicit amount.',
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      // The SDK types reverse() as an overloaded promise|callback signature; cast the result.
      const reversal = (await this.client.transfers.reverse(input.transferId, {
        amount: input.amountMinor,
      })) as { id?: string };
      if (typeof reversal?.id !== 'string' || reversal.id === '') {
        // A 200 with no reference is not acceptance we can act on, or later reconcile by.
        return { kind: 'INDETERMINATE', raw: { reason: 'no reversal id in response' } };
      }
      return { kind: 'ACCEPTED', reversalId: reversal.id, raw: reversal };
    } catch (err) {
      return razorpayReversalFailure(err);
    }
  }

  /**
   * What Razorpay says has been reversed on this transfer, in total.
   *
   * The authoritative figure, and the reason not knowing whether Route reversals are synchronous
   * does not block us: `amount_reversed` is "Amount reversed from this transfer for refunds" and
   * accumulates, while the transfer's own status distinguishes `partially_reversed` from
   * `reversed`. An attempt stuck at UNKNOWN is resolved by reading this, never by asking for the
   * reversal again.
   */
  /**
   * What Razorpay says came back out of one transfer.
   *
   * ── WHY AN UNREADABLE RESPONSE THROWS RATHER THAN READING AS ZERO ─────────────────
   * This used to substitute 0 when `amount_reversed` was missing or not a number. That is a
   * fabricated money fact, and it fails OPEN: the reconciliation engine compares cumulative
   * figures, so a 0 against a record that also says 0 reconciles as AGREES - "the provider
   * confirms nothing was reversed" - when in truth nothing was ever read. If Razorpay changed
   * its response shape, omitted the field, or wrapped the entity, we would record positive
   * confirmation that money had not moved.
   *
   * The engine cannot defend against this: it validates the number it is given, and a plausible
   * 0 passes every check. So the adapter has to refuse instead.
   *
   * Throwing is the safe outcome because the sweeper turns it into PROVIDER_UNREACHABLE, which
   * means "we could not ask" and draws no conclusion at all. A 0 we invented is worse than no
   * answer, and this matters more now that a scheduled worker can ask unattended.
   *
   * Stripe needs none of this - its SDK types `amount_reversed` as a required number. Razorpay's
   * client returns an untyped object and Route is not enabled on our test account, so this
   * response shape has never actually been observed. See the sandbox questions in the reversal
   * documentation.
   */
  async getTransferReversalState(transferId: string): Promise<TransferReversalState> {
    const transfer = (await this.client.transfers.fetch(transferId)) as unknown as {
      amount_reversed?: unknown;
      status?: unknown;
    };
    const reversed = transfer?.amount_reversed;
    if (!Number.isInteger(reversed) || (reversed as number) < 0) {
      throw new AppException(
        ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
        'Razorpay did not report a readable reversed amount for this transfer.',
        HttpStatus.BAD_GATEWAY,
        // The transfer id only. The response may carry account detail that is not ours to log.
        { transferId, field: 'amount_reversed' },
      );
    }
    const status = typeof transfer?.status === 'string' ? transfer.status : null;
    return {
      transferId,
      amountReversedMinor: reversed as number,
      /*
        Razorpay's documented terminal status for a wholly reversed transfer. A partial reversal
        is expected to leave the status alone and move `amount_reversed` only - expected, not
        proven, which is why `fullyReversed` is never the thing the ledger acts on. The amount is.
      */
      fullyReversed: status === 'reversed',
      providerStatusRaw: status,
    };
  }

  /** Fetch a Linked Account and map its KYC/activation state to our snapshot. */
  async getConnectedAccount(accountId: string): Promise<ConnectedAccountSnapshot> {
    const acc = (await this.client.accounts.fetch(accountId)) as unknown as {
      id: string;
      status?: string;
      email?: string;
    };
    const activated = acc.status === 'activated';
    return {
      accountId: acc.id,
      // Razorpay Linked Account statuses: created | activated | needs_clarification | suspended.
      detailsSubmitted: acc.status !== 'created',
      chargesEnabled: activated,
      payoutsEnabled: activated,
      requirementsCurrentlyDue: acc.status === 'needs_clarification' ? ['kyc.clarification'] : [],
      disabledReason: acc.status === 'suspended' ? 'suspended' : null,
      defaultCurrency: 'inr',
      country: 'IN',
    };
  }

  /**
   * Map Razorpay event names to our two settlement outcomes. Any other event
   * (e.g. `order.paid`, `refund.processed`) is intentionally rejected with a 4xx
   * so handleWebhook — which only understands succeeded/failed — never mis-routes.
   */
  private mapEventType(event: string | undefined): PaymentEvent['type'] {
    if (event === 'payment.captured') return 'payment.succeeded';
    if (event === 'payment.failed') return 'payment.failed';
    throw new AppException(
      ErrorCodes.PAYMENT_WEBHOOK_INVALID,
      `Unhandled Razorpay event: ${event ?? 'unknown'}.`,
      HttpStatus.BAD_REQUEST,
    );
  }

  private resolveBookingId(body: RazorpayWebhookBody): string | undefined {
    const fromPaymentNotes = body.payload?.payment?.entity?.notes?.bookingId;
    if (fromPaymentNotes != null) return String(fromPaymentNotes);
    const fromOrderNotes = body.payload?.order?.entity?.notes?.bookingId;
    if (fromOrderNotes != null) return String(fromOrderNotes);
    // Order receipt is set to the bookingId at creation time.
    const receipt = body.payload?.order?.entity?.receipt;
    return receipt != null ? String(receipt) : undefined;
  }
}

/** Map a Razorpay payment.status to our normalized lifecycle status. */
function mapPaymentStatus(status: string): PaymentStatusResult['status'] {
  switch (status) {
    case 'captured':
      return 'CAPTURED';
    case 'authorized':
      return 'AUTHORIZED';
    case 'refunded':
      return 'REFUNDED';
    case 'failed':
      return 'FAILED';
    default:
      return 'REQUIRES_PAYMENT';
  }
}

function requireKey(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new Error(
      `Razorpay requires ${key} to be set. ` +
        `Use Razorpay test keys for sandbox, live keys for production.`,
    );
  }
  return value;
}
