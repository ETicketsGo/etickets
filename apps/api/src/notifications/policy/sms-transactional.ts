import { NotificationType, marketsForE164 } from '@eticketsgo/shared-types';
import { dltTemplateFor, dltVariablesFromPayload } from '../templates/dlt-sms-templates';

/**
 * Transactional SMS in India, switched on one notification type at a time.
 *
 * ── WHY A SEPARATE SWITCH AND NOT A LINE IN EVENT_POLICY ───────────────────────────
 * The policy table says SMS is not used for these types, and that stays the default. An
 * approved DLT template makes an SMS POSSIBLE; it does not decide that every buyer should get
 * one. That is a product decision per type, and it must be reversible without a build. So
 * `SMS_TRANSACTIONAL_TYPES` lists the types that may add SMS, and it is empty by default:
 * nothing changes until somebody names a type.
 *
 * ── WHO GETS IT ────────────────────────────────────────────────────────────────────
 * Only an account holder with a VERIFIED phone number in a market listed here. The phone is
 * read from the account, never from a payload. A guest has no account to read it from, so a
 * guest gets no SMS from this switch. North America is not listed: the US and Canada keep
 * exactly the channels they have today.
 *
 * ── WHAT IS NEVER ELIGIBLE ─────────────────────────────────────────────────────────
 * PASSWORD_RESET_REQUESTED: the approved wording carries a code, and the reset flow sends an
 * email LINK. There is no code to put in the SMS, so it is refused here and at boot.
 * The sign-in code (OTP) does not pass through this policy at all.
 */
export const SMS_TRANSACTIONAL_ELIGIBLE: readonly NotificationType[] = [
  NotificationType.BOOKING_CONFIRMED,
  NotificationType.BOOKING_CANCELLED,
  NotificationType.PASSWORD_CHANGED,
  NotificationType.EVENT_REMINDER,
];

/** Markets whose numbers may receive these SMS. India only: MSG91 under DLT. */
export const SMS_TRANSACTIONAL_MARKETS: readonly string[] = ['IN'];

/** The configured list, split and trimmed. Unknown names are kept so boot can reject them. */
export function parseSmsTransactionalTypes(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

/** Configured names that may not be switched on. Empty means the setting is valid. */
export function invalidSmsTransactionalTypes(raw: string | null | undefined): string[] {
  return parseSmsTransactionalTypes(raw).filter(
    (t) => !(SMS_TRANSACTIONAL_ELIGIBLE as readonly string[]).includes(t),
  );
}

/** Whether the switch names this type. An ineligible name never counts. */
export function smsTransactionalEnabled(
  type: NotificationType,
  raw: string | null | undefined,
): boolean {
  return (
    SMS_TRANSACTIONAL_ELIGIBLE.includes(type) && parseSmsTransactionalTypes(raw).includes(type)
  );
}

/**
 * Why this recipient and payload may not get the SMS, or null when they may.
 *
 * Checked BEFORE a row is written. A row that the channel would refuse later (no number, a
 * number outside India, a variable missing) is a FAILED notification with nothing wrong with
 * it, so it is never written.
 */
export function smsTransactionalRefusal(input: {
  type: NotificationType;
  phone: string | null | undefined;
  phoneVerifiedAt: Date | null | undefined;
  payload: Record<string, unknown> | undefined;
}): string | null {
  if (!input.phone) return 'no phone';
  if (!input.phoneVerifiedAt) return 'phone not verified';
  const markets = marketsForE164(input.phone);
  if (!markets.some((m) => SMS_TRANSACTIONAL_MARKETS.includes(m))) return 'market not enabled';
  const template = dltTemplateFor(input.type);
  if (!template) return 'no DLT template';
  const vars = dltVariablesFromPayload(template, input.payload ?? {});
  if ('missing' in vars) return `missing ${vars.missing.join('+')}`;
  return null;
}
