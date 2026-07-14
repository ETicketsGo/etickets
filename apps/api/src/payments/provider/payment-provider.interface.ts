/**
 * Provider-agnostic payment abstraction. Adapters (Dummy/Stripe/Razorpay/PayPal/
 * Square) plug in behind this interface without booking logic ever seeing a
 * provider. The core three operations (createPayment/verifyWebhook/refund) are
 * required and unchanged; the richer operations are OPTIONAL so existing adapters
 * remain valid and new capabilities are added incrementally (backward compatible).
 */
import type { PaymentProviderCapabilities } from '../domain/payment-capabilities';

export interface CreatePaymentInput {
  bookingId: string;
  amountMinor: number;
  currency: string;
  buyerEmail: string;
  /** Idempotency key so retries never double-charge. */
  idempotencyKey: string;
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

export interface PaymentEvent {
  type: 'payment.succeeded' | 'payment.failed';
  providerRef: string;
  bookingId: string;
  amountMinor: number;
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
  status: 'COMPLETED' | 'FAILED';
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
  healthCheck?(): Promise<HealthCheckResult>;
  reconcile?(input: ReconcileInput): Promise<ReconcileResult>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
