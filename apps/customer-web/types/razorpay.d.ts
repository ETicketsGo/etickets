// Minimal ambient types for Razorpay Standard Checkout (checkout.js).
// Only the surface this app uses is modelled — no `any`. This file has no
// top-level import/export so it augments the global scope directly.

/** Payload handed to the Checkout `handler` after a successful capture attempt. */
interface RazorpayHandlerResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/** One payment instrument inside a Checkout display block, e.g. UPI via QR and intent. */
interface RazorpayDisplayInstrument {
  /** 'upi', 'card', 'netbanking', 'wallet', … */
  method: string;
  /** For UPI: 'qr', 'intent', 'collect'. */
  flows?: string[];
  apps?: string[];
}

interface RazorpayDisplayBlock {
  name: string;
  instruments: RazorpayDisplayInstrument[];
}

/** `config.display`: custom method blocks, their order, and whether the defaults follow. */
interface RazorpayDisplayConfig {
  /** Keyed by block id; referenced from `sequence` as `block.<id>`. */
  blocks: Record<string, RazorpayDisplayBlock>;
  sequence: string[];
  preferences: { show_default_blocks: boolean };
  hide?: RazorpayDisplayInstrument[];
}

/** Options passed to `new window.Razorpay(...)`. */
interface RazorpayOptions {
  key: string;
  order_id: string;
  /** Amount in the currency's minor unit (paise for INR). */
  amount: number;
  currency: string;
  name: string;
  description?: string;
  prefill?: { name?: string; email?: string; contact?: string };
  handler?: (response: RazorpayHandlerResponse) => void;
  modal?: { ondismiss?: () => void };
  config?: { display: RazorpayDisplayConfig };
}

/**
 * What Checkout hands a `payment.failed` listener. Checkout stays open so the buyer can retry;
 * the `reason` is what says WHY (e.g. `international_transaction_not_allowed`).
 */
interface RazorpayFailureResponse {
  error?: {
    code?: string;
    description?: string;
    source?: string;
    step?: string;
    reason?: string;
  };
}

interface RazorpayInstance {
  open(): void;
  close(): void;
  on(event: 'payment.failed', handler: (response: RazorpayFailureResponse) => void): void;
}

interface RazorpayConstructor {
  new (options: RazorpayOptions): RazorpayInstance;
}

interface Window {
  Razorpay?: RazorpayConstructor;
}
