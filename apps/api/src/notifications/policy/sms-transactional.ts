import { NotificationType, marketsForE164 } from '@eticketsgo/shared-types';
import { dltTemplateFor, dltVariablesFromPayload } from '../templates/dlt-sms-templates';
import { validateTemplatePayload } from '../templates/template-contract';

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
 * guest gets no SMS from this switch.
 *
 * ── WHICH COUNTRIES ────────────────────────────────────────────────────────────────
 * `SMS_TRANSACTIONAL_MARKETS` (default `IN`). India goes through MSG91 under DLT, so the
 * registered template and every one of its variables are checked first. The US and Canada go
 * through the existing Twilio path, which sends the type's rendered text (no DLT), so there
 * the template contract is checked instead. A +1 number cannot say whether it is American or
 * Canadian, so it is texted only when BOTH US and CA are named.
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

/** The default for SMS_TRANSACTIONAL_MARKETS: India only, MSG91 under DLT. */
export const SMS_TRANSACTIONAL_MARKETS: readonly string[] = ['IN'];

/** Every market SMS_TRANSACTIONAL_MARKETS may name: the ones with an SMS path today. */
export const SMS_TRANSACTIONAL_MARKETS_SUPPORTED: readonly string[] = ['IN', 'US', 'CA'];

/** Markets whose SMS must match a registered DLT template. */
const DLT_MARKETS: readonly string[] = ['IN'];

/** The configured markets, split and trimmed. Unset or blank is the default (India). */
export function parseSmsTransactionalMarkets(raw: string | null | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : [...SMS_TRANSACTIONAL_MARKETS];
}

/** Configured markets with no SMS path. Empty means the setting is valid. */
export function invalidSmsTransactionalMarkets(raw: string | null | undefined): string[] {
  return parseSmsTransactionalMarkets(raw).filter(
    (m) => !SMS_TRANSACTIONAL_MARKETS_SUPPORTED.includes(m),
  );
}

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
  /** The enabled markets (SMS_TRANSACTIONAL_MARKETS, parsed). Default: India only. */
  markets?: readonly string[];
}): string | null {
  if (!input.phone) return 'no phone';
  if (!input.phoneVerifiedAt) return 'phone not verified';
  const enabled = input.markets ?? SMS_TRANSACTIONAL_MARKETS;
  const markets = marketsForE164(input.phone);
  // Every market the number may belong to must be on: +1 is both the US and Canada.
  if (markets.length === 0 || !markets.every((m) => enabled.includes(m))) {
    return 'market not enabled';
  }
  if (!markets.some((m) => DLT_MARKETS.includes(m))) {
    // Twilio sends the rendered text, so the fields that text needs must all be there.
    const violation = validateTemplatePayload(input.type, input.payload);
    return violation ? `missing ${violation.missing.join('+')}` : null;
  }
  const template = dltTemplateFor(input.type);
  if (!template) return 'no DLT template';
  const vars = dltVariablesFromPayload(template, input.payload ?? {});
  if ('missing' in vars) return `missing ${vars.missing.join('+')}`;
  return null;
}
