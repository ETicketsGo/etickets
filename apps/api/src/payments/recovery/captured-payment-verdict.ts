import type { PaymentStatusResult } from '../provider/payment-provider.interface';

/**
 * What the provider says about an order whose booking is about to be thrown away.
 *
 * Three answers, not two. "No payment" and "I could not ask" look the same from the
 * database and mean opposite things: one is an abandoned cart, the other is possibly a
 * captured payment we have not heard about yet. Collapsing them is the defect this type
 * exists to prevent - see `docs/incidents/2026-10-06-payment-capture-without-confirmation.md`.
 */
export type CapturedPaymentVerdict =
  /** The provider has no successful payment for this order. The hold may be released. */
  | { kind: 'none' }
  /** The provider holds the buyer's money. The hold must NOT be released as abandoned. */
  | { kind: 'captured'; providerRef: string; amountMinor: number; currency: string }
  /** We could not get an answer. Not evidence of no payment, so release is not permitted. */
  | { kind: 'unverifiable'; reason: string };

/** Provider payment states that mean the money has actually been taken. */
const SETTLED = new Set(['CAPTURED', 'SUCCEEDED']);

/**
 * Classify an order from the payments the provider lists against it.
 *
 * `null` means the question could not be asked or answered - the adapter cannot look an
 * order up, or the call failed. That is `unverifiable`, deliberately distinct from an empty
 * list, which is a real answer meaning nobody paid.
 *
 * An order can carry several payment attempts (a failed card, then a successful UPI). Any
 * settled attempt makes the order paid, so the first settled one is what is returned; the
 * failed siblings are not evidence of anything.
 */
export function verdictFromOrderPayments(
  payments: PaymentStatusResult[] | null,
  reason = 'provider could not be queried',
): CapturedPaymentVerdict {
  if (payments === null) return { kind: 'unverifiable', reason };
  const settled = payments.find((p) => SETTLED.has(p.status));
  if (!settled) return { kind: 'none' };
  return {
    kind: 'captured',
    providerRef: settled.providerRef,
    amountMinor: settled.amountMinor,
    currency: settled.currency,
  };
}
