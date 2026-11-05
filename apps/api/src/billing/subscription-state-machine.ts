import type { SubscriptionSource, SubscriptionStatus } from '@eticketsgo/shared-types';

/**
 * The organizer subscription lifecycle, as one pure function.
 *
 * ── WHY PURE ───────────────────────────────────────────────────────────────────────
 * Every way a subscription changes - a provider event, a staff grant, the clock - goes through
 * `transition`. It reads nothing and writes nothing, so the whole table of legal moves is tested
 * without a database (subscription-state-machine.spec.ts), and the service that persists the
 * result cannot invent a move the table does not allow.
 *
 * ── THE ONE RULE ABOUT MONEY ───────────────────────────────────────────────────────
 * A subscription becomes ACTIVE (or is renewed, or changes plan mid-period) ONLY with verified
 * payment evidence: the provider's own record of a captured payment, checked by signature and
 * amount before it reaches here. An unverified provider event, a webhook without a payment, or a
 * zero amount is refused. The only other way to a paid plan's features is a staff grant
 * (trial or complimentary), which is recorded as such and never as a payment.
 *
 * ── STATES ─────────────────────────────────────────────────────────────────────────
 *   TRIALING       a trial, until trialEndsAt.
 *   ACTIVE         paid for the current period.
 *   PAST_DUE       a renewal payment failed; features kept while the provider retries.
 *   GRACE          retries are over; features kept until graceEndsAt, then EXPIRED.
 *   COMPLIMENTARY  granted by staff, until currentPeriodEnd (null = open-ended).
 *   CANCELLED      ended by cancellation. Terminal.
 *   EXPIRED        ended by the clock (trial, grace or complimentary ran out). Terminal.
 * A terminal subscription is history. Starting again creates a new subscription row.
 */

export interface PaymentEvidence {
  /** True only when the provider's record was verified (signature and amount). */
  verified: boolean;
  provider: string;
  paymentRef: string;
  amountMinor: number;
  currency: string;
}

export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  source: SubscriptionSource;
  planId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  scheduledPlanId: string | null;
  cancelledAt: Date | null;
  endedAt: Date | null;
}

export type SubscriptionEvent =
  | { type: 'START_TRIAL'; planId: string; trialEndsAt: Date }
  | { type: 'TRIAL_ENDED' }
  | {
      type: 'ACTIVATE';
      planId: string;
      periodStart: Date;
      periodEnd: Date;
      evidence: PaymentEvidence | null;
    }
  | { type: 'RENEW'; periodEnd: Date; evidence: PaymentEvidence | null }
  | { type: 'PAYMENT_FAILED' }
  | { type: 'ENTER_GRACE'; graceEndsAt: Date }
  | { type: 'GRACE_ENDED' }
  | { type: 'CANCEL_AT_PERIOD_END' }
  | { type: 'RESUME' }
  | { type: 'PERIOD_ENDED' }
  | { type: 'SCHEDULE_PLAN_CHANGE'; planId: string }
  | { type: 'CANCEL_SCHEDULED_CHANGE' }
  | { type: 'CHANGE_PLAN_NOW'; planId: string; evidence: PaymentEvidence | null }
  | { type: 'GRANT_COMPLIMENTARY'; planId: string; endsAt: Date | null }
  | { type: 'COMPLIMENTARY_ENDED' }
  | { type: 'REVOKE' }
  | { type: 'CANCEL_NOW' };

export type SubscriptionEventType = SubscriptionEvent['type'];

export class SubscriptionTransitionError extends Error {
  constructor(
    readonly code: 'INVALID_TRANSITION' | 'PAYMENT_NOT_VERIFIED' | 'TOO_EARLY' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'SubscriptionTransitionError';
  }
}

export interface TransitionResult {
  next: SubscriptionSnapshot;
  /** True when the move starts a NEW subscription (from none, or from a terminal one). */
  creates: boolean;
}

const TERMINAL: ReadonlySet<SubscriptionStatus> = new Set(['CANCELLED', 'EXPIRED']);

export function isTerminal(status: SubscriptionStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * How long an ACTIVE subscription keeps its features past the end of its period while the
 * renewal event is on its way. A provider's webhook can be late; a paying customer must not lose
 * features for it. A subscription set to cancel at period end gets no tolerance.
 */
export const RENEWAL_TOLERANCE_MS = 3 * 24 * 60 * 60 * 1000;

/** Whether a subscription in this state grants its plan's entitlements at `at`. */
export function grantsEntitlements(s: SubscriptionSnapshot, at: Date): boolean {
  const t = at.getTime();
  if (t < s.currentPeriodStart.getTime()) return false;
  switch (s.status) {
    case 'TRIALING':
      return !!s.trialEndsAt && t < s.trialEndsAt.getTime();
    case 'ACTIVE': {
      if (!s.currentPeriodEnd) return true;
      const end = s.currentPeriodEnd.getTime() + (s.cancelAtPeriodEnd ? 0 : RENEWAL_TOLERANCE_MS);
      return t < end;
    }
    case 'PAST_DUE':
      return true;
    case 'GRACE':
      return !!s.graceEndsAt && t < s.graceEndsAt.getTime();
    case 'COMPLIMENTARY':
      return !s.currentPeriodEnd || t < s.currentPeriodEnd.getTime();
    default:
      return false;
  }
}

function refuse(from: SubscriptionStatus | null, type: string): never {
  throw new SubscriptionTransitionError(
    'INVALID_TRANSITION',
    `A subscription that is ${from ?? 'not started'} cannot take ${type}.`,
  );
}

function requireVerifiedPayment(evidence: PaymentEvidence | null): PaymentEvidence {
  if (
    !evidence ||
    evidence.verified !== true ||
    !evidence.paymentRef ||
    !Number.isInteger(evidence.amountMinor) ||
    evidence.amountMinor <= 0 ||
    !evidence.currency
  ) {
    throw new SubscriptionTransitionError(
      'PAYMENT_NOT_VERIFIED',
      'A paid plan starts, renews or changes only with a verified payment from the provider.',
    );
  }
  return evidence;
}

function fresh(
  base: Partial<SubscriptionSnapshot> &
    Pick<SubscriptionSnapshot, 'status' | 'source' | 'planId' | 'currentPeriodStart'>,
): SubscriptionSnapshot {
  return {
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    graceEndsAt: null,
    scheduledPlanId: null,
    cancelledAt: null,
    endedAt: null,
    ...base,
  };
}

/** Moves a subscription by one event. Throws {@link SubscriptionTransitionError} when illegal. */
export function transition(
  current: SubscriptionSnapshot | null,
  event: SubscriptionEvent,
  now: Date,
): TransitionResult {
  const from = current?.status ?? null;
  const startable = !current || isTerminal(current.status);
  const keep = (patch: Partial<SubscriptionSnapshot>): TransitionResult => ({
    next: { ...(current as SubscriptionSnapshot), ...patch },
    creates: false,
  });
  const end = (status: 'CANCELLED' | 'EXPIRED'): TransitionResult =>
    keep({
      status,
      endedAt: now,
      cancelledAt: status === 'CANCELLED' ? now : (current?.cancelledAt ?? null),
      scheduledPlanId: null,
    });
  const notBefore = (at: Date | null, what: string) => {
    if (!at || now.getTime() < at.getTime()) {
      throw new SubscriptionTransitionError('TOO_EARLY', `${what} has not been reached yet.`);
    }
  };

  switch (event.type) {
    case 'START_TRIAL': {
      if (!startable) refuse(from, event.type);
      if (event.trialEndsAt.getTime() <= now.getTime()) {
        throw new SubscriptionTransitionError('INVALID_INPUT', 'A trial must end in the future.');
      }
      return {
        next: fresh({
          status: 'TRIALING',
          source: 'TRIAL',
          planId: event.planId,
          currentPeriodStart: now,
          currentPeriodEnd: event.trialEndsAt,
          trialEndsAt: event.trialEndsAt,
        }),
        creates: true,
      };
    }

    case 'TRIAL_ENDED':
      if (from !== 'TRIALING') refuse(from, event.type);
      notBefore(current!.trialEndsAt, 'The end of the trial');
      return end('EXPIRED');

    case 'ACTIVATE': {
      const allowed = startable || from === 'TRIALING' || from === 'COMPLIMENTARY';
      if (!allowed) refuse(from, event.type);
      requireVerifiedPayment(event.evidence);
      if (event.periodEnd.getTime() <= event.periodStart.getTime()) {
        throw new SubscriptionTransitionError(
          'INVALID_INPUT',
          'A period must end after it starts.',
        );
      }
      const next = fresh({
        status: 'ACTIVE',
        source: 'PROVIDER',
        planId: event.planId,
        currentPeriodStart: event.periodStart,
        currentPeriodEnd: event.periodEnd,
      });
      // From a trial or a complimentary plan the same subscription converts; otherwise a new one.
      return { next, creates: startable };
    }

    case 'RENEW': {
      if (from !== 'ACTIVE' && from !== 'PAST_DUE' && from !== 'GRACE') refuse(from, event.type);
      if (current!.cancelAtPeriodEnd) {
        throw new SubscriptionTransitionError(
          'INVALID_TRANSITION',
          'A subscription set to cancel at the end of its period does not renew.',
        );
      }
      requireVerifiedPayment(event.evidence);
      const follows = current!.currentPeriodEnd ?? now;
      if (event.periodEnd.getTime() <= follows.getTime()) {
        throw new SubscriptionTransitionError(
          'INVALID_INPUT',
          'A renewal must end after the period it follows.',
        );
      }
      // The new period starts where the old one ended, but never later than now. A renewal paid
      // before the old end (the provider reset the billing cycle, or charged early) would
      // otherwise start in the future, and `grantsEntitlements` refuses a period that has not
      // started: a customer who has just paid would drop to FREE until the old end.
      const start = follows.getTime() > now.getTime() ? now : follows;
      return keep({
        status: 'ACTIVE',
        planId: current!.scheduledPlanId ?? current!.planId,
        scheduledPlanId: null,
        currentPeriodStart: start,
        currentPeriodEnd: event.periodEnd,
        graceEndsAt: null,
      });
    }

    case 'PAYMENT_FAILED':
      if (from === 'PAST_DUE') return keep({});
      if (from !== 'ACTIVE') refuse(from, event.type);
      return keep({ status: 'PAST_DUE' });

    case 'ENTER_GRACE':
      if (from !== 'PAST_DUE') refuse(from, event.type);
      if (event.graceEndsAt.getTime() <= now.getTime()) {
        throw new SubscriptionTransitionError('INVALID_INPUT', 'A grace period must end later.');
      }
      return keep({ status: 'GRACE', graceEndsAt: event.graceEndsAt });

    case 'GRACE_ENDED':
      if (from !== 'GRACE') refuse(from, event.type);
      notBefore(current!.graceEndsAt, 'The end of the grace period');
      return end('EXPIRED');

    case 'CANCEL_AT_PERIOD_END':
      if (from !== 'ACTIVE' && from !== 'PAST_DUE') refuse(from, event.type);
      return keep({ cancelAtPeriodEnd: true, scheduledPlanId: null });

    case 'RESUME':
      if (from !== 'ACTIVE' || !current!.cancelAtPeriodEnd) refuse(from, event.type);
      return keep({ cancelAtPeriodEnd: false });

    case 'PERIOD_ENDED':
      if (from !== 'ACTIVE' || !current!.cancelAtPeriodEnd) refuse(from, event.type);
      notBefore(current!.currentPeriodEnd, 'The end of the period');
      return end('CANCELLED');

    case 'SCHEDULE_PLAN_CHANGE':
      if (from !== 'ACTIVE') refuse(from, event.type);
      if (event.planId === current!.planId) {
        throw new SubscriptionTransitionError('INVALID_INPUT', 'That is already the plan.');
      }
      return keep({ scheduledPlanId: event.planId, cancelAtPeriodEnd: false });

    case 'CANCEL_SCHEDULED_CHANGE':
      if (from !== 'ACTIVE' || !current!.scheduledPlanId) refuse(from, event.type);
      return keep({ scheduledPlanId: null });

    case 'CHANGE_PLAN_NOW':
      if (from !== 'ACTIVE') refuse(from, event.type);
      if (event.planId === current!.planId) {
        throw new SubscriptionTransitionError('INVALID_INPUT', 'That is already the plan.');
      }
      requireVerifiedPayment(event.evidence);
      return keep({ planId: event.planId, scheduledPlanId: null });

    case 'GRANT_COMPLIMENTARY': {
      if (!startable && from !== 'TRIALING') refuse(from, event.type);
      if (event.endsAt && event.endsAt.getTime() <= now.getTime()) {
        throw new SubscriptionTransitionError(
          'INVALID_INPUT',
          'A complimentary plan must end in the future.',
        );
      }
      return {
        next: fresh({
          status: 'COMPLIMENTARY',
          source: 'ADMIN_COMPLIMENTARY',
          planId: event.planId,
          currentPeriodStart: now,
          currentPeriodEnd: event.endsAt,
        }),
        creates: startable,
      };
    }

    case 'COMPLIMENTARY_ENDED':
      if (from !== 'COMPLIMENTARY') refuse(from, event.type);
      notBefore(current!.currentPeriodEnd, 'The end of the complimentary plan');
      return end('EXPIRED');

    case 'REVOKE':
      if (from !== 'TRIALING' && from !== 'COMPLIMENTARY') refuse(from, event.type);
      return end('EXPIRED');

    case 'CANCEL_NOW':
      if (startable) refuse(from, event.type);
      return end('CANCELLED');
  }
}

/**
 * The clock-driven move due for a subscription at `now`, if any: the trial, grace period,
 * complimentary plan or cancelled period has run out. Used by the sweep.
 */
export function dueTimedEvent(s: SubscriptionSnapshot, now: Date): SubscriptionEvent | null {
  const past = (d: Date | null) => !!d && now.getTime() >= d.getTime();
  if (s.status === 'TRIALING' && past(s.trialEndsAt)) return { type: 'TRIAL_ENDED' };
  if (s.status === 'GRACE' && past(s.graceEndsAt)) return { type: 'GRACE_ENDED' };
  if (s.status === 'COMPLIMENTARY' && past(s.currentPeriodEnd)) {
    return { type: 'COMPLIMENTARY_ENDED' };
  }
  if (s.status === 'ACTIVE' && s.cancelAtPeriodEnd && past(s.currentPeriodEnd)) {
    return { type: 'PERIOD_ENDED' };
  }
  return null;
}
