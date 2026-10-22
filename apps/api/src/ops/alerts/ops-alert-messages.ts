import { AppException } from '../../common/errors';
import type { OpsAlert } from './ops-alert.service';

/*
  One builder per alert, so the wording and - more importantly - the list of facts each one is
  allowed to carry live in one reviewable file. Every fact here is an id, an amount, a status or
  a code. Nothing here is handed a payload, a signature, an address or a phone number, so none
  of them can be put in an email by mistake.
*/

/** A delivery refused because its signature did not verify. Never the signature or the body. */
export function webhookSignatureAlert(
  provider: string,
  eventId: string | undefined,
  bytes: number,
): OpsAlert {
  return {
    kind: 'WEBHOOK_SIGNATURE_REJECTED',
    key: provider,
    summary: `${provider} webhook rejected: signature did not verify`,
    facts: { provider, providerEventId: eventId ?? 'none', bodyBytes: bytes },
    where:
      `The ${provider} webhook secret on the API does not match the one signing deliveries. ` +
      `Compare it with the webhook settings in the ${provider} dashboard. Until it is fixed, ` +
      'payments can be captured without their bookings being confirmed. API log: ' +
      `"REJECTED a ${provider} webhook"; metric payment_webhooks{result="signature_invalid"}.`,
  };
}

/** Money captured for a booking that could not take it (expired, cancelled, or paid twice). */
export function captureNotAppliedAlert(input: {
  bookingId: string;
  paymentId: string | null;
  provider: string;
  providerRef: string;
  amountMinor: number;
  currency: string;
  bookingStatus: string;
  duplicate: boolean;
  reason?: string;
}): OpsAlert {
  return {
    kind: 'CAPTURE_NOT_APPLIED',
    key: input.providerRef || input.bookingId,
    summary: input.duplicate
      ? `Customer charged twice: second capture on booking ${input.bookingId}`
      : `Payment captured for a booking that cannot be paid (${input.bookingId})`,
    facts: {
      bookingId: input.bookingId,
      paymentId: input.paymentId,
      provider: input.provider,
      providerRef: input.providerRef,
      amountMinor: input.amountMinor,
      currency: input.currency,
      bookingStatus: input.bookingStatus,
      reason: input.reason,
    },
    where:
      'No tickets were issued for this money. Admin console > Finance reconciliation (an open ' +
      'discrepancy was filed); audit log action ' +
      (input.duplicate ? 'PAYMENT_DUPLICATE_CAPTURE' : 'PAYMENT_CAPTURED_ON_UNPAYABLE_BOOKING') +
      '. Decide whether to refund the customer or honour the booking. Nothing is refunded ' +
      'automatically.',
  };
}

/** The expiry sweep found a capture on a booking it was about to release. */
export function expiryFoundCaptureAlert(input: {
  bookingId: string;
  provider: string;
  providerOrderId: string;
  providerRef: string;
  amountMinor: number;
  currency: string;
  outcome: 'recovered' | 'recovery_failed';
  errorCode?: string;
}): OpsAlert {
  return {
    kind: 'EXPIRY_FOUND_CAPTURE',
    key: input.bookingId,
    summary:
      input.outcome === 'recovered'
        ? `Paid booking ${input.bookingId} was about to expire; recovered from ${input.provider}`
        : `Paid booking ${input.bookingId} could not be recovered; stock is held`,
    facts: {
      bookingId: input.bookingId,
      provider: input.provider,
      providerOrderId: input.providerOrderId,
      providerRef: input.providerRef,
      amountMinor: input.amountMinor,
      currency: input.currency,
      outcome: input.outcome,
      errorCode: input.errorCode,
    },
    where:
      'The provider had the money but no confirmation reached us, which usually means webhooks ' +
      'are failing (check for a signature-rejected alert). ' +
      (input.outcome === 'recovered'
        ? 'The booking went through the normal confirmation path; check it in Admin console > Bookings.'
        : 'The booking was NOT released and the next sweep retries. Check Admin console > ' +
          'Bookings and Finance reconciliation; API/worker log "Recovery of booking".'),
  };
}

/** A new open item in the finance reconciliation queue. */
export function discrepancyOpenedAlert(input: {
  discrepancyId: string;
  type: string;
  provider: string;
  entityRef: string;
  amountMinor: number | null;
  currency: string | null;
  env: string;
  detail: string;
}): OpsAlert {
  return {
    kind: 'FINANCE_DISCREPANCY_OPENED',
    // Grouped by type: a detection run that files fifty mismatches is one email with a count.
    key: input.type,
    summary: `Finance discrepancy opened: ${input.type}`,
    facts: {
      discrepancyId: input.discrepancyId,
      type: input.type,
      provider: input.provider,
      entityRef: input.entityRef,
      amountMinor: input.amountMinor,
      currency: input.currency,
      paymentEnv: input.env,
      detail: input.detail,
    },
    where:
      'Admin console > Finance reconciliation. Financial records are never corrected ' +
      'automatically; assign and resolve it there.',
  };
}

/** A provider said the payment succeeded and our confirmation of the booking threw. */
export function confirmationFailedAlert(input: {
  bookingId: string;
  providerRef: string;
  amountMinor: number;
  error: unknown;
}): OpsAlert {
  return {
    kind: 'CONFIRMATION_FAILED_AFTER_PAYMENT',
    key: input.bookingId,
    summary: `Booking ${input.bookingId} was not confirmed after a successful payment`,
    facts: {
      bookingId: input.bookingId,
      providerRef: input.providerRef,
      amountMinor: input.amountMinor,
      ...errorFacts(input.error),
    },
    where:
      'The webhook is retried (up to 6 attempts) and then dead-lettered. Admin console > ' +
      'Bookings for this booking, and the API/worker log for the full error. If the amount ' +
      'does not match, an audit entry PAYMENT_AMOUNT_MISMATCH was written.',
  };
}

/** A payment webhook gave up after its last retry. */
export function webhookDeadLetteredAlert(input: {
  provider: string;
  webhookEventId: string;
  providerEventId: string;
  eventType: string;
  attempts: number;
}): OpsAlert {
  return {
    kind: 'WEBHOOK_DEAD_LETTERED',
    key: input.provider,
    summary: `${input.provider} webhook dead-lettered: ${input.eventType}`,
    facts: {
      provider: input.provider,
      webhookEventId: input.webhookEventId,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      attempts: input.attempts,
    },
    where:
      'It will not be retried automatically. The WebhookEvent row (status DEAD_LETTER) holds ' +
      'the error; audit log action WEBHOOK_DEAD_LETTER; worker log "dead-lettered".',
  };
}

/** A customer notification that has stopped retrying. */
export function notificationFailedAlert(input: {
  notificationId: string;
  type: string;
  channel: string;
  failureClass: string;
  attempts: number;
  permanent: boolean;
}): OpsAlert {
  return {
    kind: 'NOTIFICATION_FAILED',
    // Grouped by channel and cause: a broken provider is one problem, not one per customer.
    key: `${input.channel}:${input.failureClass}`,
    summary: `A ${input.channel} notification failed for good (${input.failureClass})`,
    facts: {
      notificationId: input.notificationId,
      notificationType: input.type,
      channel: input.channel,
      failureClass: input.failureClass,
      attempts: input.attempts,
      permanent: input.permanent,
    },
    where:
      'The Notification row (status FAILED, lastError) and GET /api/admin/notifications/' +
      `${input.notificationId}; worker log "notification ... failed after". A configuration or credential class ` +
      'means every message on this channel is failing, not just this one.',
  };
}

/** The error's code, and its message only when it is one of our own. */
function errorFacts(err: unknown): Record<string, string> {
  if (err instanceof AppException) return { errorCode: err.code, error: err.message };
  // Anything else may quote a query or a payload, so only its class is reported.
  return { errorCode: err instanceof Error ? err.name : 'unknown' };
}

/** The pilot guard paused events on its own. What was paused, and why, so a person can resume. */
export function pilotAutoPausedAlert(input: {
  trigger: string;
  eventIds: string[];
  bookingId?: string | null;
  sourceKind: string;
}): OpsAlert {
  return {
    kind: 'PILOT_AUTO_PAUSED',
    key: input.trigger,
    summary: `Pilot sales paused: ${input.eventIds.length} event(s) after ${input.trigger}`,
    facts: {
      trigger: input.trigger,
      sourceAlert: input.sourceKind,
      pausedEventIds: input.eventIds.join(' '),
      bookingId: input.bookingId,
    },
    where:
      'Admin console > Events: each paused event shows as paused by an admin, and only an ' +
      'admin can put it back on sale. Audit log action EVENT_AUTO_PAUSED holds the reason. ' +
      'Find and fix the cause first (see the alert named in sourceAlert).',
  };
}

/**
 * The daily budget for sign-in-code text messages was reached (`tripped`) or neared
 * (`warning`). Counts and the market only - never a phone number, not even masked: the point
 * of the alert is the SHAPE of the traffic, and one number in an email is a person's data.
 */
export function otpSmsBudgetAlert(input: {
  phase: 'tripped' | 'warning';
  /** `total`, or the market whose own budget it is (IN, US, CA). */
  scope: string;
  sentToday: number;
  dailyLimit: number;
  warnPercent: number;
  dayUtc: string;
}): OpsAlert {
  const where = input.scope === 'total' ? 'all markets' : input.scope;
  return {
    kind: 'OTP_SMS_BUDGET',
    key: `${input.phase}:${input.scope}:${input.dayUtc}`,
    summary:
      input.phase === 'tripped'
        ? `Sign-in text messages STOPPED: daily SMS budget reached (${where})`
        : `Sign-in text messages at ${input.warnPercent}% of the daily SMS budget (${where})`,
    facts: {
      phase: input.phase,
      budget: input.scope,
      sentToday: input.sentToday,
      dailyLimit: input.dailyLimit,
      dayUtc: input.dayUtc,
      effect:
        input.phase === 'tripped'
          ? 'Phone sign-in answers SMS_UNAVAILABLE until the next UTC day. Email sign-in works.'
          : 'Nothing is blocked yet.',
    },
    where:
      'Metric etg_otp_sms_requests_total by market and outcome. Many different numbers in one ' +
      'market is the shape of SMS pumping. Limits: OTP_SMS_DAILY_LIMIT_TOTAL and ' +
      'OTP_SMS_DAILY_LIMIT_BY_MARKET on the api service.',
  };
}
