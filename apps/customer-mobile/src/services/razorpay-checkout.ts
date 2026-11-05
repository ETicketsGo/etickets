import { Platform } from 'react-native';
import type { RazorpayOrder } from '@/features/checkout/schema';

/**
 * Razorpay's native checkout, behind a seam.
 *
 * Razorpay takes the payment on the device: its SDK draws the card, netbanking, wallet
 * and UPI screens and hands UPI to the buyer's UPI app. The server has already created
 * the ORDER (amount, currency, which account is paid), so nothing the app passes here
 * can change what is charged. Razorpay checks the amount against the order.
 *
 * The module is required lazily and only on Android and iOS. Importing it builds a
 * NativeEventEmitter at once, which throws in the web preview and under Jest, where no
 * native module exists.
 */

/** What Razorpay hands back on success. Proves nothing until the server verifies it. */
export interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

export type RazorpayResult =
  { kind: 'paid'; response: RazorpaySuccess } | { kind: 'not-paid'; reason: string | null };

type Opener = (options: Record<string, unknown>) => Promise<unknown>;

let opener: Opener | null = null;

/** Tests replace the native module with this. */
export function setRazorpayOpenerForTests(fn: Opener | null): void {
  opener = fn;
}

function loadOpener(): Opener | null {
  if (opener) return opener;
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('react-native-razorpay') as { default?: { open: Opener }; open?: Opener };
  const checkout = mod.default ?? mod;
  if (typeof checkout.open !== 'function') return null;
  opener = (options) => checkout.open!(options);
  return opener;
}

export function razorpayAvailable(): boolean {
  return loadOpener() !== null;
}

/** The brand gold, so the Razorpay sheet does not look like another company's page. */
const THEME_COLOR = '#B8893B';

export async function openRazorpayCheckout(order: RazorpayOrder): Promise<RazorpayResult> {
  const open = loadOpener();
  if (!open) return { kind: 'not-paid', reason: 'Payments are not available on this device.' };

  const prefill = order.prefill ?? {};
  const options = {
    key: order.keyId,
    order_id: order.orderId,
    amount: order.amountMinor,
    currency: order.currency,
    name: order.name ?? 'ETicketsGo',
    description: order.description ?? undefined,
    prefill: {
      name: prefill.name ?? undefined,
      email: prefill.email ?? undefined,
      contact: prefill.contact ?? undefined,
    },
    theme: { color: THEME_COLOR },
  };

  try {
    const data = (await open(options)) as Partial<RazorpaySuccess> | null;
    if (data?.razorpay_payment_id && data.razorpay_order_id && data.razorpay_signature) {
      return {
        kind: 'paid',
        response: {
          razorpay_payment_id: data.razorpay_payment_id,
          razorpay_order_id: data.razorpay_order_id,
          razorpay_signature: data.razorpay_signature,
        },
      };
    }
    // Success with no signature cannot be verified. The webhook may still confirm it,
    // which is why the caller re-reads the booking either way.
    return { kind: 'not-paid', reason: null };
  } catch (err) {
    // Cancelled, declined, network lost. The SDK's numeric codes differ by platform, so
    // they are not interpreted here; the server's booking status decides what happened.
    return { kind: 'not-paid', reason: errorDescription(err) };
  }
}

function errorDescription(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { description?: unknown; error?: { description?: unknown } };
  const text = typeof e.description === 'string' ? e.description : e.error?.description;
  if (typeof text !== 'string') return null;
  // The Android SDK sometimes sends its whole error object as a JSON string. Its inner
  // description is then the reason, and the envelope itself is never shown to a buyer.
  let reason = text;
  try {
    const parsed = JSON.parse(text) as { error?: { description?: unknown } } | null;
    if (parsed && typeof parsed === 'object') {
      const inner = parsed.error?.description;
      reason = typeof inner === 'string' ? inner : '';
    }
  } catch {
    // Not JSON: use as is.
  }
  // Closing or declining sends the literal string "undefined" (sometimes inside that JSON),
  // which the buyer saw as the reason: "undefined  Your tickets are still held". Seen on a
  // moto g31, twice, by two different routes; so every candidate goes through this check.
  const trimmed = reason.trim();
  if (!trimmed || /^(undefined|null)$/i.test(trimmed)) return null;
  return trimmed;
}
