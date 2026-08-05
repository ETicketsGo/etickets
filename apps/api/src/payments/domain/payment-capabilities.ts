/**
 * Payments domain layer — provider-agnostic capability model.
 *
 * Capabilities let the routing/orchestration layers reason about what a provider
 * can do (countries, currencies, methods, partial refunds, auth/capture, …)
 * WITHOUT any provider-specific logic leaking out of its adapter. Every adapter
 * declares its own `capabilities`.
 */

/** Payment methods the platform knows about (provider-agnostic). */
export const PaymentMethod = {
  CARD: 'CARD',
  UPI: 'UPI',
  NETBANKING: 'NETBANKING',
  WALLET: 'WALLET',
  APPLE_PAY: 'APPLE_PAY',
  GOOGLE_PAY: 'GOOGLE_PAY',
  PAYPAL: 'PAYPAL',
  BANK_TRANSFER: 'BANK_TRANSFER',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export interface PaymentProviderCapabilities {
  /** ISO 3166-1 alpha-2 country codes the provider serves (e.g. ['IN'], ['US','CA']). */
  countries: string[];
  /** ISO 4217 currency codes the provider settles (e.g. ['INR'], ['USD','GBP']). */
  currencies: string[];
  paymentMethods: PaymentMethod[];
  supportsPartialRefunds: boolean;
  supportsMultiplePartialRefunds: boolean;
  supportsAuthorizeCapture: boolean;
  /**
   * Void support (ADR-043 P5.3B Phase 5): cancelling an authorization BEFORE capture. A
   * provider that only immediate-captures must set this false (its compensation is REFUND, not
   * VOID). `supportsIdempotentVoid` gates automatic void execution; `supportsPaymentStatusQuery`
   * enables status recovery for ambiguous outcomes. Defaults false — set true only when the
   * adapter genuinely wires cancel/getPayment.
   */
  supportsVoid: boolean;
  supportsIdempotentVoid: boolean;
  supportsPaymentStatusQuery: boolean;
  /**
   * Full-refund support (ADR-043 P5.3B Phase 6). `supportsIdempotentRefund` gates AUTOMATIC
   * refund execution — if the adapter cannot prove idempotent refunds, auto-refund stays
   * unavailable for that provider. `supportsRefundStatusQuery` enables status recovery;
   * `refundMayBeAsynchronous` marks providers whose refund completes later (e.g. Razorpay).
   * Defaults false — set true only where the adapter genuinely behaves this way.
   */
  supportsFullRefund: boolean;
  supportsIdempotentRefund: boolean;
  supportsRefundStatusQuery: boolean;
  refundMayBeAsynchronous: boolean;
  supportsConnectedAccounts: boolean;
  supportsApplePay: boolean;
  supportsGooglePay: boolean;
  supportsUPI: boolean;
  supportsNetBanking: boolean;
  supportsWallets: boolean;
}

/** True when the provider can serve a (country, currency) pair. */
export function capabilitySupports(
  cap: PaymentProviderCapabilities,
  country: string,
  currency: string,
): boolean {
  const anyCountry = cap.countries.includes('*') || cap.countries.includes(country.toUpperCase());
  const anyCurrency =
    cap.currencies.includes('*') || cap.currencies.includes(currency.toUpperCase());
  return anyCountry && anyCurrency;
}
