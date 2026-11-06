import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { captureOperationalEvent } from '../../observability/sentry';
import { OpsAlertService, type OpsAlert, type OpsAlertKind } from './ops-alert.service';

/**
 * Every operations alert also goes to Sentry, as one issue per kind and key.
 *
 * The ops alerts are the platform's list of money-critical and security failures that are
 * HANDLED - nothing throws to the exception filter, so Sentry never saw them: a webhook whose
 * signature does not verify, a capture that could not be applied, a webhook dead-lettered, a
 * confirmation that failed after payment, a finance discrepancy, a refresh token replayed.
 * The email is throttled; Sentry gets every occurrence and groups them itself
 * (fingerprint = kind + key), so its alert rules can count and page.
 *
 * Alert facts are ids, amounts, codes and statuses by contract (OpsAlertFact), never a person,
 * and they pass through the same scrub as every other event anyway. A no-op without a DSN.
 */
const ERROR_KINDS: ReadonlySet<OpsAlertKind> = new Set<OpsAlertKind>([
  'WEBHOOK_SIGNATURE_REJECTED',
  'CAPTURE_NOT_APPLIED',
  'EXPIRY_FOUND_CAPTURE',
  'CONFIRMATION_FAILED_AFTER_PAYMENT',
  'WEBHOOK_DEAD_LETTERED',
  'FINANCE_DISCREPANCY_OPENED',
  'PILOT_AUTO_PAUSED',
  'AUTH_REFRESH_TOKEN_REUSE',
]);

export function opsAlertToSentry(alert: OpsAlert) {
  return {
    message: `[ops] ${alert.kind}: ${alert.summary}`,
    level: ERROR_KINDS.has(alert.kind) ? ('error' as const) : ('warning' as const),
    fingerprint: ['ops-alert', alert.kind, alert.key],
    tags: { alert_kind: alert.kind, area: areaOf(alert.kind) },
    extra: { ...alert.facts, where: alert.where },
  };
}

function areaOf(kind: OpsAlertKind): string {
  if (kind.startsWith('WEBHOOK_')) return 'payments.webhook';
  if (kind === 'CAPTURE_NOT_APPLIED' || kind === 'EXPIRY_FOUND_CAPTURE') return 'payments.capture';
  if (kind === 'CONFIRMATION_FAILED_AFTER_PAYMENT') return 'checkout';
  if (kind === 'FINANCE_DISCREPANCY_OPENED') return 'finance';
  if (kind === 'NOTIFICATION_FAILED' || kind === 'OTP_SMS_BUDGET') return 'notifications';
  if (kind === 'BILLING_PRICE_MISMATCH') return 'billing';
  if (kind === 'PILOT_AUTO_PAUSED') return 'pilot';
  return 'security';
}

@Injectable()
export class OpsAlertSentryBridge implements OnModuleInit {
  constructor(@Optional() private readonly alerts?: OpsAlertService) {}

  onModuleInit(): void {
    this.alerts?.subscribe((alert) => captureOperationalEvent(opsAlertToSentry(alert)));
  }
}
