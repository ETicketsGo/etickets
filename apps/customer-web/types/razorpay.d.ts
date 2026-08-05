// Minimal ambient types for Razorpay Standard Checkout (checkout.js).
// Only the surface this app uses is modelled — no `any`. This file has no
// top-level import/export so it augments the global scope directly.

/** Payload handed to the Checkout `handler` after a successful capture attempt. */
interface RazorpayHandlerResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
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
}

interface RazorpayInstance {
  open(): void;
  close(): void;
}

interface RazorpayConstructor {
  new (options: RazorpayOptions): RazorpayInstance;
}

interface Window {
  Razorpay?: RazorpayConstructor;
}
