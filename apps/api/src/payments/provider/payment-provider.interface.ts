/**
 * Provider-agnostic payment abstraction. Adapters (Dummy/Stripe/Razorpay/PayPal/
 * Square) plug in behind this interface without booking logic ever seeing a
 * provider. The core three operations (createPayment/verifyWebhook/refund) are
 * required and unchanged; the richer operations are OPTIONAL so existing adapters
 * remain valid and new capabilities are added incrementally (backward compatible).
 */
import type { PaymentFailureReason } from '@eticketsgo/shared-types';
import type { PaymentProviderCapabilities } from '../domain/payment-capabilities';

export interface CreatePaymentInput {
  bookingId: string;
  amountMinor: number;
  currency: string;
  buyerEmail: string;
  /** Idempotency key so retries never double-charge. */
  idempotencyKey: string;
  /**
   * Marketplace fields (Stripe Connect, Separate Charges & Transfers). Optional so
   * non-marketplace providers ignore them. When present the charge lands on the
   * PLATFORM and is tagged with `transferGroup` so a later transfer can move
   * `amountMinor − platformFeeAmountMinor` to `connectedAccountId`. The transfer is
   * NOT created here — settlement happens after the event.
   */
  connectedAccountId?: string;
  platformFeeAmountMinor?: number;
  transferGroup?: string;
  /** Extra non-sensitive metadata (eventId/organizerId/customerId/environment). */
  metadata?: Record<string, string>;
  /** Human-readable line-item label for the hosted checkout. */
  description?: string;
}

export interface PaymentIntent {
  providerRef: string;
  /** URL/redirect or client secret the frontend uses to complete payment. */
  clientActionUrl: string;
  status: 'REQUIRES_PAYMENT';
}

export interface WebhookInput {
  /** Raw request body (string) used for signature verification. */
  rawBody: string;
  signature: string;
}

/** Razorpay Checkout success payload the client returns for synchronous verification. */
export interface CheckoutVerifyInput {
  orderId: string;
  paymentId: string;
  signature: string;
}

export interface PaymentEvent {
  type: 'payment.succeeded' | 'payment.failed';
  providerRef: string;
  bookingId: string;
  amountMinor: number;
  /**
   * Why a `payment.failed` failed, when the provider said. `reason` is ours and is what the
   * buyer is told; `providerCode` is the provider's own token (e.g.
   * `international_transaction_not_allowed`), kept on the attempt for support — never its prose.
   */
  failure?: { reason: PaymentFailureReason; providerCode: string | null };
}

/**
 * A signature-verified provider webhook, normalized so the (provider-neutral)
 * webhook pipeline can persist + dispatch it without importing provider SDK types.
 * `object` is the event's primary object; consumers cast it per `type`.
 */
export interface WebhookEnvelope {
  id: string;
  type: string;
  createdAt: number;
  /** Connect events carry the connected-account id here. */
  account?: string | null;
  object: unknown;
}

export interface RefundInput {
  providerRef: string;
  amountMinor: number;
  reason?: string;
  /**
   * ISO-4217 currency of the original payment. Optional for backward compatibility
   * (Stripe/Razorpay infer it); PayPal/Square require it to format a partial refund.
   */
  currency?: string;
}

export interface RefundResult {
  providerRef: string;
  /**
   * PROCESSING: the provider accepted the refund but has not paid it yet (Razorpay `pending`).
   * Its final state arrives later by webhook, so it must not be recorded as COMPLETED.
   */
  status: 'COMPLETED' | 'PROCESSING' | 'FAILED';
}

/** Normalized lifecycle status for a payment, read back from the provider. */
export type PaymentLifecycleStatus =
  | 'REQUIRES_PAYMENT'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface PaymentStatusResult {
  providerRef: string;
  status: PaymentLifecycleStatus;
  amountMinor: number;
  currency: string;
}

export interface CaptureInput {
  providerRef: string;
  /** Optional partial capture; omit to capture the full authorized amount. */
  amountMinor?: number;
}

export interface CancelInput {
  providerRef: string;
}

export interface HealthCheckResult {
  healthy: boolean;
  mode: 'dummy' | 'test' | 'live';
  message?: string;
}

export interface ReconcileInput {
  from: Date;
  to: Date;
}

export interface ReconcileResult {
  checked: number;
  matched: number;
  mismatches: { providerRef: string; issue: string }[];
}

// ─── Connect (marketplace) operations ───

export interface CreateConnectedAccountInput {
  organizationId: string;
  /** ISO-3166 alpha-2 country of the organizer's business. */
  country: string;
  email?: string;
}

export interface CreateConnectedAccountResult {
  accountId: string;
}

/** Provider-agnostic snapshot of a connected account's capability state. */
export interface ConnectedAccountSnapshot {
  accountId: string;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  /** Field names only (never PII). */
  requirementsCurrentlyDue: string[];
  disabledReason?: string | null;
  defaultCurrency?: string | null;
  country?: string | null;
}

export interface OnboardingLinkInput {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
}

export interface OnboardingLinkResult {
  url: string;
  /** Unix seconds when the link expires (provider-defined). */
  expiresAt?: number;
}

export interface DashboardLinkResult {
  url: string;
}

// ─── Transfers & reversals (settlement money movement) ───

export interface TransferInput {
  amountMinor: number;
  currency: string;
  destinationAccountId: string;
  transferGroup?: string;
  /** Idempotency key so a re-run never creates a duplicate transfer. */
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

/**
 * What a provider's answer to a TRANSFER request actually proves.
 *
 * ── WHY THIS REPLACED `{ transferId, status }` ─────────────────────────────────────
 * The old shape could say COMPLETED or FAILED and nothing else, and both adapters hardcoded
 * COMPLETED on any non-throwing response. Everything else - a timeout, a connection reset, an
 * unreadable body - became a thrown error that the caller recorded as a failure.
 *
 * That is the exact defect `ReversalOutcome` was created to fix, on the side that moves the
 * SMALLER amount back. This is the same union for the side that sends the organizer's whole
 * payout out, and it exists so "I do not know" can be REPORTED rather than inferred.
 *
 * ── WHY THERE IS NO `CONFIRMED` ────────────────────────────────────────────────────
 * A successful `transfers.create` proves the provider ACCEPTED the instruction. Neither adapter
 * reads anything that proves the money has settled with the organizer, so claiming more would be
 * the hardcoded-COMPLETED mistake again in a new shape. A `CONFIRMED` arm belongs here only when
 * an adapter can produce the evidence for it.
 */
export type TransferOutcome =
  /** The provider took the instruction and gave us a reference. Settlement is NOT proven. */
  | { kind: 'ACCEPTED'; transferId: string; raw: unknown }
  /** The provider refused, authoritatively, without acting. Not a transport failure. */
  | { kind: 'REFUSED'; code: string; message: string; retryable: boolean; raw: unknown }
  /**
   * We cannot say what happened.
   *
   * A timeout, a connection error, or a response we cannot interpret. The provider may have
   * moved money while our answer was lost, so this is NOT a failure and must never be retried
   * blindly - the recovery is to ask the provider what it did.
   */
  | { kind: 'INDETERMINATE'; raw: unknown };

export interface TransferReversalInput {
  transferId: string;
  amountMinor?: number;
  idempotencyKey: string;
}

/**
 * What a provider's answer to a reversal request actually proves.
 *
 * ── WHY A UNION AND NOT A STATUS STRING ────────────────────────────────────────────
 * This replaced `{ reversalId, status: 'COMPLETED' | 'FAILED' }`, which had two faults that
 * compounded. Both adapters hardcoded `COMPLETED` without reading any provider evidence, AND the
 * caller never looked at the field anyway - it reacted only to thrown exceptions. So fixing one
 * without the other would have changed nothing.
 *
 * A discriminated union fixes the second fault structurally: the caller must narrow before it
 * can read anything, so a result cannot be discarded by accident. `CONFIRMED` carries
 * `confirmedMinor` as a required field, which makes manufacturing completion without an amount
 * impossible to write rather than merely discouraged.
 *
 * `raw` is always present so the attempt row can keep the provider's own words for diagnosis and
 * reconciliation, rather than only our interpretation of them.
 */
export type ReversalOutcome =
  /** The provider proved the money came back, and for how much. The ONLY outcome that moves money. */
  | { kind: 'CONFIRMED'; reversalId: string; confirmedMinor: number; raw: unknown }
  /** The provider has the operation and gave us a reference. Completion is NOT proven. */
  | { kind: 'ACCEPTED'; reversalId: string; raw: unknown }
  /** The provider refused, authoritatively. Not a transport failure. */
  | { kind: 'REFUSED'; code: string; message: string; retryable: boolean; raw: unknown }
  /**
   * We cannot say what happened.
   *
   * A timeout, a connection error, or a response we cannot interpret. The provider may have
   * moved money while our answer was lost, so this is NOT a failure and must never be retried
   * blindly - the recovery is to ask the provider what it did.
   */
  | { kind: 'INDETERMINATE'; raw: unknown };

/**
 * How much of a transfer the provider says has come back, in total.
 *
 * Cumulative, not per-reversal: it is the figure both providers maintain on the transfer itself,
 * and the only one either of them will stand behind.
 */
export interface TransferReversalState {
  transferId: string;
  /** Total reversed so far, across every reversal on this transfer. */
  amountReversedMinor: number;
  /** The provider considers the whole transfer reversed. */
  fullyReversed: boolean;
  /** The provider's own status word, unmapped, for diagnosis. */
  providerStatusRaw: string | null;
}

/**
 * The provider contract. `createPayment`/`verifyWebhook`/`refund` and
 * `capabilities` are required; everything else is OPTIONAL and adapters implement
 * them as the provider supports them (advertised via `capabilities`). This keeps
 * the contract backward compatible while allowing auth/capture, reconciliation,
 * and health checks per provider.
 */
export interface PaymentProvider {
  readonly name: string;
  /**
   * HTTP header the provider signs its webhooks with (verified in verifyWebhook).
   * Examples: dummy → 'x-payment-signature', stripe → 'stripe-signature',
   * razorpay → 'x-razorpay-signature'.
   */
  readonly webhookSignatureHeader: string;
  /** What this provider can do — used by the routing/orchestration layers. */
  readonly capabilities: PaymentProviderCapabilities;

  createPayment(input: CreatePaymentInput): Promise<PaymentIntent>;
  verifyWebhook(input: WebhookInput): Promise<PaymentEvent>;
  refund(input: RefundInput): Promise<RefundResult>;

  // Optional richer operations (implemented per provider capability):
  authorize?(input: CreatePaymentInput): Promise<PaymentIntent>;
  capture?(input: CaptureInput): Promise<PaymentStatusResult>;
  cancel?(input: CancelInput): Promise<PaymentStatusResult>;
  getPayment?(providerRef: string): Promise<PaymentStatusResult>;
  getRefund?(refundRef: string): Promise<RefundResult>;
  /** Parse an already-verified webhook body (verifyWebhook does both by default). */
  parseWebhook?(rawBody: string): PaymentEvent;
  /**
   * Verify a webhook signature and return a normalized envelope (id/type/object) for
   * the full range of provider events — used by the durable, async webhook pipeline.
   */
  verifySignedEnvelope?(input: WebhookInput): WebhookEnvelope;
  healthCheck?(): Promise<HealthCheckResult>;
  reconcile?(input: ReconcileInput): Promise<ReconcileResult>;

  // Optional Connect (marketplace) operations — implemented when the provider
  // supports connected accounts (capabilities.supportsConnectedAccounts).
  createConnectedAccount?(
    input: CreateConnectedAccountInput,
  ): Promise<CreateConnectedAccountResult>;
  getConnectedAccount?(accountId: string): Promise<ConnectedAccountSnapshot>;
  createOnboardingLink?(input: OnboardingLinkInput): Promise<OnboardingLinkResult>;
  /** Login/dashboard link — only for account types that support it (e.g. Express). */
  createDashboardLink?(accountId: string): Promise<DashboardLinkResult>;
  /** Move funds to a connected account (settlement). */
  createTransfer?(input: TransferInput): Promise<TransferOutcome>;
  /** Reverse (claw back) a prior transfer, e.g. after a post-transfer refund. */
  reverseTransfer?(input: TransferReversalInput): Promise<ReversalOutcome>;
  /**
   * What the provider says has been reversed on a transfer, in total.
   *
   * ── WHY THE TRANSFER AND NOT THE REVERSAL ───────────────────────────────
   * Neither provider's REVERSAL entity carries a status, so neither can answer "did it work?"
   * about itself. Both providers do carry a cumulative figure on the TRANSFER:
   *
   *   Stripe    Transfer.amount_reversed - "can be less than the amount attribute on the
   *             transfer if a partial reversal was issued" - plus `reversed: boolean`
   *   Razorpay  Transfer.amount_reversed - "Amount reversed from this transfer for refunds" -
   *             plus status 'partially_reversed' | 'reversed'
   *
   * So the same question has the same authoritative answer at both providers, and it is a READ.
   * This is how an attempt stuck at UNKNOWN is resolved: ask what was reversed, never reissue.
   */
  getTransferReversalState?(transferId: string): Promise<TransferReversalState>;
  /** Razorpay: verify the Checkout success signature (order_id|payment_id, HMAC key secret). */
  verifyCheckoutSignature?(input: CheckoutVerifyInput): boolean;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
