/**
 * Provider-agnostic payment abstraction. The MVP ships a MockPaymentProvider;
 * Stripe/Razorpay implementations plug in behind the same interface without
 * touching booking logic.
 */

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
}

export interface RefundResult {
  providerRef: string;
  status: 'COMPLETED' | 'FAILED';
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<PaymentIntent>;
  verifyWebhook(input: WebhookInput): Promise<PaymentEvent>;
  refund(input: RefundInput): Promise<RefundResult>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
