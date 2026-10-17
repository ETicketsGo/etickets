/**
 * Settling a refund call whose answer was lost, by asking the provider instead of resending.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The payment orchestrator used to retry a timed-out refund call twice. A timeout says nothing
 * about what the provider did: the call may have landed and only its answer been lost on the
 * way back. Each retry could then pay the customer again. Refund calls are now sent once, and
 * when the answer is lost the payment's refunds are fetched from the provider and judged here.
 *
 * ── THE KEY ────────────────────────────────────────────────────────────────────────
 * Every call for a refund carries a key that starts with `etg-rf-<refundId>`. Stripe receives
 * it as its Idempotency-Key header and in `metadata`; Razorpay in `receipt` and `notes`. The key
 * is what lets a lookup recognise OUR refund among the payment's refunds when we never learned
 * the provider's id for it.
 *
 * The key is reused for every call that follows a lost answer, so Stripe returns the first
 * refund instead of making a second one. It changes only after the provider gave a definite
 * answer to it (refused, or accepted and later failed), because Stripe replays that same answer
 * for 24 hours under the same key, and a new request for the money is a new operation.
 *
 * ── WHAT COUNTS AS "CLEARLY NO REFUND" ─────────────────────────────────────────────
 * Only a lookup that answered, and showed neither a refund with our key nor one we cannot
 * account for of the same amount since the refund was asked for. A refund with no key of ours
 * and the same amount could be this one (made before keys existed, or by hand from the
 * provider dashboard), so it stops everything automatic and goes to a person.
 *
 * Pure: no database, no clock, no provider. Every rule is exercised by `refund-reconcile.spec.ts`.
 */
import type { ProviderRefundRecord } from '../payments/provider/payment-provider.interface';

const PREFIX = 'etg-rf-';

/** How far before the refund was asked for an unkeyed same-amount refund still counts. */
export const STRANGER_WINDOW_MS = 10 * 60_000;

/**
 * How long after a call whose answer was lost an empty lookup still proves nothing.
 *
 * Measured against the real Razorpay TEST API (2026-10-16, 8 tries): a refund is listed the
 * instant its create call is answered, but not while the call is in flight, and a create took
 * 1.5-2.6 s. A call we timed out on (15 s) may be slower than that, and our timer does not stop
 * the request, so the window is far wider than anything measured. Inside it, "the provider shows
 * no refund" is treated as "unknown": the refund is held and nothing is sent.
 */
export const RECHECK_AFTER_MS = 10 * 60_000;

/** When an empty lookup can be believed, for a call that started at `startedAt`. */
export function recheckAfter(startedAt: Date): Date {
  return new Date(startedAt.getTime() + RECHECK_AFTER_MS);
}

/** Why a refund is held when the provider did not list it right after a lost answer. */
export function noneTooSoonReason(startedAt: Date): string {
  return (
    'The payment provider did not answer, and it does not list this refund yet. The call may ' +
    'still be in progress there, so nothing was sent again. Ask the provider again after ' +
    `${recheckAfter(startedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
  );
}

/** The stem every key of this refund starts with. */
export function refundKeyStem(refundId: string): string {
  return `${PREFIX}${refundId}`;
}

/**
 * The key for one generation of calls. Generation 1 is the stem itself; later ones are suffixed,
 * so every key a refund has used still starts with its stem. Razorpay's `receipt` holds 40
 * characters; a cuid id makes this 32 for generation 1 and at most 36 for generation 999.
 */
export function refundKey(refundId: string, generation: number): string {
  return generation <= 1 ? refundKeyStem(refundId) : `${refundKeyStem(refundId)}-${generation}`;
}

/** The generation a key belongs to (1 for the bare stem), or null when it is not this refund's. */
export function keyGeneration(key: string, refundId: string): number | null {
  const stem = refundKeyStem(refundId);
  if (key === stem) return 1;
  if (!key.startsWith(`${stem}-`)) return null;
  const n = Number(key.slice(stem.length + 1));
  return Number.isInteger(n) && n > 1 ? n : null;
}

/** Whether a key was made by this platform at all, for this refund or another. */
export function isPlatformKey(key: string | null): boolean {
  return typeof key === 'string' && key.startsWith(PREFIX);
}

export type Reconciliation =
  /** The provider holds a refund made with this refund's key, not refused. It is this refund. */
  | { kind: 'FOUND'; record: ProviderRefundRecord }
  /** The provider holds the CURRENT key's refund and refused it. A definite answer; no money. */
  | { kind: 'REFUSED'; record: ProviderRefundRecord }
  /** The provider answered and shows nothing that could be this refund. */
  | { kind: 'NONE' }
  /** The provider shows something that may be this refund but cannot be matched. A person. */
  | { kind: 'UNMATCHED'; reason: string }
  /** The provider could not be asked, or did not answer. A person, or ask again later. */
  | { kind: 'UNAVAILABLE'; reason: string };

export interface ReconcileContext {
  refundId: string;
  amountMinor: number;
  /** The key the most recent call carried; a refused refund under it is a definite answer. */
  currentKey: string | null;
  /** Provider refund ids already accounted for by refund rows here (this booking's). */
  knownRefs: readonly string[];
  /** When the refund was asked for. Unkeyed refunds before this window are not suspects. */
  askedAt: Date;
}

/** Judge a provider's list of a payment's refunds against one refund of ours. */
export function reconcileRefund(
  records: readonly ProviderRefundRecord[],
  ctx: ReconcileContext,
): Reconciliation {
  const ours = records.filter(
    (r) => r.idempotencyKey !== null && keyGeneration(r.idempotencyKey, ctx.refundId) !== null,
  );
  const live = ours.filter((r) => r.status !== 'FAILED');
  if (live.length > 1) {
    return {
      kind: 'UNMATCHED',
      reason: `The provider shows ${live.length} refunds made for this one refund. The customer may have been paid more than once.`,
    };
  }
  if (live.length === 1) {
    if (live[0].amountMinor !== ctx.amountMinor) {
      return {
        kind: 'UNMATCHED',
        reason: `The provider shows a refund for this refund of a different amount (${live[0].amountMinor} instead of ${ctx.amountMinor}).`,
      };
    }
    return { kind: 'FOUND', record: live[0] };
  }

  const known = new Set(ctx.knownRefs);
  const earliest = ctx.askedAt.getTime() - STRANGER_WINDOW_MS;
  const strangers = records.filter(
    (r) =>
      r.status !== 'FAILED' &&
      !isPlatformKey(r.idempotencyKey) &&
      !known.has(r.refundRef) &&
      r.amountMinor === ctx.amountMinor &&
      (r.createdAt === null || r.createdAt.getTime() >= earliest),
  );
  if (strangers.length > 0) {
    return {
      kind: 'UNMATCHED',
      reason:
        "The provider shows a refund of the same amount on this payment that does not carry this refund's key. It may be this one, or one made by hand in the provider dashboard.",
    };
  }

  const refused = ctx.currentKey
    ? ours.find((r) => r.idempotencyKey === ctx.currentKey && r.status === 'FAILED')
    : undefined;
  if (refused) return { kind: 'REFUSED', record: refused };
  return { kind: 'NONE' };
}
