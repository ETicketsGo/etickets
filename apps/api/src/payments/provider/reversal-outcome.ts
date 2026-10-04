import type { ReversalOutcome, TransferOutcome } from './payment-provider.interface';

/**
 * Turning a provider's answer into what it actually proves.
 *
 * ── THE RULE THESE ALL FOLLOW ──────────────────────────────────────────────────────
 * An error becomes `REFUSED` only when it proves the provider did NOT act. Anything else is
 * `INDETERMINATE`, because the provider may have moved money while our answer was lost.
 *
 * That asymmetry is deliberate and costly in the right direction. `REFUSED` invites a retry;
 * retrying an operation that may already have succeeded is how the same money comes back twice.
 * `INDETERMINATE` invites a QUESTION - ask the provider what it did - which is slower and cannot
 * move money by mistake.
 *
 * Pure functions over error shapes, so every branch is testable without an SDK or a sandbox.
 */

/** The parts of a thrown provider error these decisions are allowed to read. */
export interface ProviderErrorLike {
  type?: unknown;
  code?: unknown;
  statusCode?: unknown;
  message?: unknown;
}

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Stripe error types that prove the request was rejected without being acted on.
 *
 * Each is a refusal Stripe makes BEFORE doing anything: a malformed request, a bad key, a rate
 * limit, or an idempotency key reused with different parameters. None of them can leave a
 * reversal half-made.
 */
const STRIPE_AUTHORITATIVE_REFUSALS = new Set([
  'StripeInvalidRequestError',
  'StripeAuthenticationError',
  'StripePermissionError',
  'StripeRateLimitError',
  'StripeIdempotencyError',
]);

/** A refusal we may safely ask again about later, once the cause is fixed or passes. */
const STRIPE_RETRYABLE_REFUSALS = new Set(['StripeRateLimitError']);

/**
 * What a thrown Stripe error proves.
 *
 * `StripeConnectionError` and `StripeAPIError` are deliberately NOT refusals: the first means we
 * never learned whether the request arrived, and the second is Stripe failing after accepting
 * it. Both are exactly the case `INDETERMINATE` exists for.
 */
export function stripeReversalFailure(err: unknown): ReversalOutcome {
  const e = (err ?? {}) as ProviderErrorLike;
  const type = asString(e.type) ?? (err as { name?: string })?.name ?? '';
  const message = asString(e.message) ?? 'Stripe reversal failed.';

  if (STRIPE_AUTHORITATIVE_REFUSALS.has(type)) {
    return {
      kind: 'REFUSED',
      code: asString(e.code) ?? type,
      message,
      retryable: STRIPE_RETRYABLE_REFUSALS.has(type),
      raw: redactProviderError(err),
    };
  }
  // Includes StripeConnectionError, StripeAPIError, and anything we have not met.
  return { kind: 'INDETERMINATE', raw: redactProviderError(err) };
}

/**
 * What a thrown Razorpay error proves: nothing, for now.
 *
 * ── WHY EVERY RAZORPAY ERROR IS AMBIGUOUS ──────────────────────────────────────────
 * Razorpay's error taxonomy for Route reversals is not evidenced anywhere in this repository -
 * not in the SDK types, not in our own code. So there is no way to tell an authoritative refusal
 * from transport noise, and guessing has an asymmetric cost: a timeout wrongly classed `REFUSED`
 * invites a retry of an operation that may have succeeded.
 *
 * Until a sandbox session establishes which errors mean "we did nothing", every one of them is
 * `INDETERMINATE` and gets resolved by asking Razorpay what it did - `transfers.fetch()` returns
 * the transfer's cumulative `amount_reversed`, which is authoritative.
 *
 * This is a placeholder for EVIDENCE, not for effort.
 */
export function razorpayReversalFailure(err: unknown): ReversalOutcome {
  return { kind: 'INDETERMINATE', raw: redactProviderError(err) };
}

/**
 * What survives of a provider error for storage.
 *
 * A thrown error can carry request headers, keys and customer detail. The attempt row is read by
 * support and by reconciliation, so it keeps the fields that identify the fault and nothing that
 * identifies the account.
 */
export function redactProviderError(err: unknown): Record<string, unknown> {
  const e = (err ?? {}) as ProviderErrorLike;
  return {
    type: asString(e.type) ?? (err as { name?: string })?.name ?? 'unknown',
    code: asString(e.code) ?? null,
    statusCode: typeof e.statusCode === 'number' ? e.statusCode : null,
    message: (asString(e.message) ?? '').slice(0, 300),
  };
}

/* ─── The same decisions, for the side that sends money OUT ────────────────────────── */

/**
 * What a thrown Stripe error proves about a TRANSFER.
 *
 * The rule and the error sets are the same as for a reversal, because the question is the same:
 * did the provider decline before acting, or might it have acted while our answer was lost? The
 * asymmetry is if anything sharper here - a transfer is the organizer's whole payout, so a
 * timeout wrongly classed `REFUSED` invites a retry that pays it twice.
 */
export function stripeTransferFailure(err: unknown): TransferOutcome {
  const e = (err ?? {}) as ProviderErrorLike;
  const type = asString(e.type) ?? (err as { name?: string })?.name ?? '';
  const message = asString(e.message) ?? 'Stripe transfer failed.';

  if (STRIPE_AUTHORITATIVE_REFUSALS.has(type)) {
    return {
      kind: 'REFUSED',
      code: asString(e.code) ?? type,
      message,
      retryable: STRIPE_RETRYABLE_REFUSALS.has(type),
      raw: redactProviderError(err),
    };
  }
  // Includes StripeConnectionError, StripeAPIError, and anything we have not met.
  return { kind: 'INDETERMINATE', raw: redactProviderError(err) };
}

/**
 * What a thrown Razorpay error proves about a TRANSFER: nothing, for now.
 *
 * Same position as `razorpayReversalFailure`, and for the same reason: Razorpay's error taxonomy
 * for Route is not evidenced anywhere in this repository, so there is no way to tell an
 * authoritative refusal from transport noise. Every error is therefore `INDETERMINATE`, which
 * costs a question rather than a duplicate payout.
 *
 * This is a placeholder for EVIDENCE, not for effort. Narrowing it requires a sandbox session,
 * not a guess.
 */
export function razorpayTransferFailure(err: unknown): TransferOutcome {
  return { kind: 'INDETERMINATE', raw: redactProviderError(err) };
}
