import { OutcomeClass } from './notification-cost';

/**
 * What actually went wrong when a message did not go out.
 *
 * ── WHY `FAILED` WAS NOT ENOUGH ────────────────────────────────────────────────────
 * Everything that threw ended up as one status with a free-text message beside it, recorded
 * as `PROVIDER_UNAVAILABLE`. That single classification covered a missing MSG91 auth key, an
 * unapproved DLT template, a phone number that does not exist, a rate limit, and Twilio
 * actually being down — and three of those five are not the provider's doing at all.
 *
 * The consequences were not cosmetic. Provider health counted our own missing credentials
 * against the provider, so a completely unconfigured India looked like an MSG91 outage. The
 * retry loop treated a permanently missing template as worth three more attempts. And an
 * operator reading the queue could not tell "somebody needs to finish the DLT registration"
 * from "wait five minutes".
 *
 * ── WHY A SEPARATE ENUM FROM `OutcomeClass` ────────────────────────────────────────
 * They answer different questions and want different granularity. `OutcomeClass` answers
 * "whose fault, for the purposes of a health denominator" and must stay small — a health
 * report with ten buckets is a health report nobody reads. This answers "what does an
 * engineer or operator do about it", where the distinctions are the whole value.
 *
 * Every value here maps onto exactly one `OutcomeClass` ({@link outcomeClassForFailure}), so
 * the two can never disagree about a single attempt.
 */
export const FailureClass = {
  /**
   * Something this platform was supposed to be told and was not: a missing credential, a
   * missing sender id, a market with no provider routed to it.
   *
   * Not the provider's fault, not retryable, and not something that changes until a human
   * edits configuration and redeploys.
   */
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  /**
   * The credential exists and the provider rejected it. Distinct from CONFIGURATION_ERROR
   * because the fix is different — a rotated key, a suspended account, an expired token —
   * and because it means we DID reach them.
   */
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  /** Too many, too fast. The request was fine; there was just more of it than allowed. */
  RATE_LIMIT: 'RATE_LIMIT',
  /** A 5xx, a timeout, a socket that went away. Try again shortly. */
  TEMPORARY_PROVIDER_ERROR: 'TEMPORARY_PROVIDER_ERROR',
  /** They answered, and the answer was no, and it will be no again. */
  PERMANENT_REJECTION: 'PERMANENT_REJECTION',
  /** The number or address is not a real destination. Retrying reaches the same nowhere. */
  INVALID_DESTINATION: 'INVALID_DESTINATION',
  /**
   * Policy requires a provider template for this type and none is bound.
   *
   * Its own class rather than CONFIGURATION_ERROR because it is the single most likely
   * blocker at launch, it is per notification TYPE rather than per provider, and the fix is
   * an approval in somebody else's console rather than a value we already hold.
   */
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  /** A template is bound and the provider refused it: not approved, wrong variable count. */
  TEMPLATE_REJECTED: 'TEMPLATE_REJECTED',
  /**
   * A regulator or carrier refused it — DLT registration missing, a sender header not
   * registered, a country the account may not message.
   *
   * Separate from PERMANENT_REJECTION because nothing about the message can be changed to
   * fix it; somebody has to complete a registration.
   */
  COMPLIANCE_BLOCKED: 'COMPLIANCE_BLOCKED',
  /** They answered with something we do not recognise. Kept honest rather than guessed. */
  UNKNOWN_PROVIDER_ERROR: 'UNKNOWN_PROVIDER_ERROR',
} as const;
export type FailureClass = (typeof FailureClass)[keyof typeof FailureClass];

/**
 * Whether another attempt could plausibly succeed WITHOUT anybody changing anything.
 *
 * That qualifier is the whole rule. A missing template might well "succeed later" — after a
 * telecom operator approves it next week — but no number of retries between now and then does
 * anything except spend attempts and bury the row. Retry is for conditions that clear on
 * their own; everything else is for a human to see.
 */
export function isRetryableFailure(cls: FailureClass): boolean {
  switch (cls) {
    case FailureClass.RATE_LIMIT:
    case FailureClass.TEMPORARY_PROVIDER_ERROR:
      return true;
    /*
      Unknown gets the benefit of the doubt, bounded by the attempt limit. Between dropping a
      message we might have delivered and spending two more attempts on one we will not, the
      cheaper mistake is the second — and an unrecognised response is more often a transient
      gateway page than a considered refusal.
    */
    case FailureClass.UNKNOWN_PROVIDER_ERROR:
      return true;
    case FailureClass.CONFIGURATION_ERROR:
    case FailureClass.AUTHENTICATION_ERROR:
    case FailureClass.PERMANENT_REJECTION:
    case FailureClass.INVALID_DESTINATION:
    case FailureClass.TEMPLATE_NOT_FOUND:
    case FailureClass.TEMPLATE_REJECTED:
    case FailureClass.COMPLIANCE_BLOCKED:
      return false;
  }
}

/**
 * Whether this failure means somebody has to change configuration or finish a registration,
 * as opposed to waiting or accepting the outcome.
 *
 * This is the filter an operator wants: "what is blocked on me".
 */
export function isConfigurationBlocked(cls: FailureClass): boolean {
  return (
    cls === FailureClass.CONFIGURATION_ERROR ||
    cls === FailureClass.AUTHENTICATION_ERROR ||
    cls === FailureClass.TEMPLATE_NOT_FOUND ||
    cls === FailureClass.COMPLIANCE_BLOCKED
  );
}

/**
 * The health-report bucket for a failure.
 *
 * ── WHY CONFIGURATION NEVER COUNTS AGAINST A PROVIDER ──────────────────────────────
 * `CONFIGURATION_BLOCKED` is deliberately outside `isProviderOutcome`, so an unconfigured
 * market contributes nothing to any provider's failure rate. Otherwise the health report for
 * MSG91 reads 100% failure before we have even opened an account with them, and the number
 * that is supposed to detect a real outage is already pinned at the top.
 *
 * It is also outside `reachedProvider`, so nothing is ever priced for a call that was never
 * made.
 */
export function outcomeClassForFailure(cls: FailureClass): OutcomeClass {
  switch (cls) {
    case FailureClass.CONFIGURATION_ERROR:
    case FailureClass.TEMPLATE_NOT_FOUND:
    case FailureClass.COMPLIANCE_BLOCKED:
      return OutcomeClass.CONFIGURATION_BLOCKED;
    /*
      Authentication is a configuration problem that we found out about BY calling them. It
      still must not count against their reliability -- a rotated key is not an outage -- so
      it lands in the same bucket, and the finer distinction survives in `failureClass`.
    */
    case FailureClass.AUTHENTICATION_ERROR:
      return OutcomeClass.CONFIGURATION_BLOCKED;
    case FailureClass.RATE_LIMIT:
    case FailureClass.TEMPORARY_PROVIDER_ERROR:
      return OutcomeClass.PROVIDER_UNAVAILABLE;
    case FailureClass.INVALID_DESTINATION:
      return OutcomeClass.UNDELIVERABLE_DESTINATION;
    case FailureClass.PERMANENT_REJECTION:
    case FailureClass.TEMPLATE_REJECTED:
    case FailureClass.UNKNOWN_PROVIDER_ERROR:
      return OutcomeClass.PROVIDER_REJECTED;
  }
}

/**
 * Classify an HTTP status from a messaging provider.
 *
 * A starting point that every adapter refines with what it knows: the status alone cannot
 * tell a bad template from a bad number, because most providers answer both with 400.
 */
export function failureClassForStatus(status: number): FailureClass {
  if (status === 401 || status === 403) return FailureClass.AUTHENTICATION_ERROR;
  if (status === 429) return FailureClass.RATE_LIMIT;
  if (status >= 500) return FailureClass.TEMPORARY_PROVIDER_ERROR;
  if (status >= 400) return FailureClass.PERMANENT_REJECTION;
  return FailureClass.UNKNOWN_PROVIDER_ERROR;
}
