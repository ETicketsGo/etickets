import { marketsForE164 } from '@eticketsgo/shared-types';

/**
 * The consent scope for texting somebody about their own booking.
 *
 * Written at signup when the person ticks the text-message box (see
 * `AuthService.recordSignupSmsConsent`) and on the account settings endpoint. It is NOT `sms`:
 * `sms` on that table means "you may sell to me by text", and this means "you may text me
 * about my booking". Neither ever answers for the other.
 */
export const SMS_TRANSACTIONAL_SCOPE = 'sms:transactional';

/**
 * Markets where a transactional SMS needs an affirmative `sms:transactional` record first.
 *
 * ── WHY THE US AND CANADA ──────────────────────────────────────────────────────────
 * A text to a +1 number rests on the recipient's prior express consent (the TCPA, and the
 * CTIA rules every US and Canadian carrier enforces), and the registered A2P 10DLC campaign names its opt-in: the unchecked box on
 * the sign-up page. A carrier reviewing the campaign expects every number we text to have
 * gone through that box. A number on an account is a way to reach somebody, not a request to
 * be reached, so a verified phone alone is not enough here.
 *
 * ── WHY NOT INDIA ──────────────────────────────────────────────────────────────────
 * India is unchanged on purpose. Booking texts there go through MSG91 as DLT-registered
 * TRANSACTIONAL templates, sent only to a number the person proved with a sign-in code, and
 * under TRAI's rules that category is about the person's own transaction and does not depend
 * on a separate opt-in record. No Indian customer has ever been asked for this consent (the
 * settings screen does not offer it), so requiring it would stop every Indian booking text
 * overnight for people who were never given the choice. A customer who does not want them
 * turns SMS off in their notification preferences, which the resolver already honours.
 * If India ever needs an opt-in, add it to this list: this is the one place the rule lives.
 *
 * ── A NUMBER WHOSE MARKET IS UNKNOWN ───────────────────────────────────────────────
 * Needs consent. We cannot show that it is exempt, and the safe answer to "may we text a
 * number we cannot place?" is no.
 */
export const SMS_CONSENT_REQUIRED_MARKETS: readonly string[] = ['US', 'CA'];

/** The current state of one person's `sms:transactional` consent. */
export type SmsConsentState = 'granted' | 'withdrawn' | 'none';

/** Skip reasons, recorded as `not_sent: <reason>` on the SMS row. ASCII, no number in them. */
export const SMS_SKIP_REASON = {
  NO_CONSENT: 'no sms consent',
  CONSENT_WITHDRAWN: 'sms consent withdrawn',
  CONSENT_UNREADABLE: 'sms consent could not be checked',
  SUPPRESSED: 'destination suppressed',
} as const;

/** Whether a text to this number needs an `sms:transactional` consent on file. */
export function smsConsentRequiredFor(phone: string): boolean {
  const markets = marketsForE164(phone);
  if (markets.length === 0) return true;
  return markets.some((m) => SMS_CONSENT_REQUIRED_MARKETS.includes(m));
}

/**
 * Why this text may not go out for lack of consent, or null when it may.
 *
 * Marketing consent (`sms`) is never read here: a person who agreed to promotional texts has
 * not thereby agreed to anything else, and one who declined them still gets their tickets in
 * a market that does not need an opt-in. The newest `sms:transactional` row decides, because
 * the table is append-only and a withdrawal is a later row with `granted = false`.
 *
 * `readConsent` is only called when the market needs consent, so an Indian booking costs no
 * extra query. A failure to read it is NOT caught here: the caller decides whether to skip
 * (enqueue) or retry (send), and neither may treat "we could not tell" as yes.
 */
export async function smsConsentRefusal(input: {
  phone: string | null | undefined;
  hasSubject: boolean;
  readConsent: () => Promise<SmsConsentState>;
}): Promise<string | null> {
  if (!input.phone) return null;
  if (!smsConsentRequiredFor(input.phone)) return null;
  if (!input.hasSubject) return SMS_SKIP_REASON.NO_CONSENT;
  const state = await input.readConsent();
  if (state === 'granted') return null;
  return state === 'withdrawn' ? SMS_SKIP_REASON.CONSENT_WITHDRAWN : SMS_SKIP_REASON.NO_CONSENT;
}
