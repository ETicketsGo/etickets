/**
 * A provider's error text, made safe to keep.
 *
 * ── WHY PROVIDER PROSE IS NOT SAFE AS IT ARRIVES ───────────────────────────────────
 * The failure columns were documented as "never contains the message or the destination",
 * and nothing enforced it. Twilio's own error messages name the number they refused
 * ("The 'To' number +1415… is not a valid phone number"), so a dead number was written in the
 * clear into `failureReason` and `Notification.lastError` -- long-lived, widely readable,
 * included in every backup -- and into any log line or Sentry event that carried the error.
 *
 * ── WHY PATTERNS AND NOT A LIST OF PROVIDER MESSAGES ───────────────────────────────
 * Providers reword their errors without notice. A table of known messages would stop
 * protecting anybody the first time one changed. What does not change is the SHAPE of the
 * things that must not be kept: a phone number, an email address, a credential.
 *
 * ── WHAT IS DELIBERATELY KEPT ──────────────────────────────────────────────────────
 * Provider error CODES (`21211`) and message SIDs (`SM…`). The code is what an operator acts
 * on and carries nothing about the person; the message SID is how a support ticket is traced
 * back to the provider's own logs. Both are short enough that none of the patterns below
 * match them, and the tests pin that.
 */

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Credentials embedded in a URL: scheme://user:secret@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[credentials]@'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]'],
  // Account and API-key SIDs name the account a credential belongs to.
  [/\b(?:AC|SK)[0-9a-fA-F]{32}\b/g, '[account]'],
  // A bare run of 32+ hex characters is the shape of an auth token or an API secret.
  [/\b[0-9a-fA-F]{32,}\b/g, '[redacted]'],
  // Anything written with a leading +, which is how every provider prints E.164.
  [/\+\d[\d\s().-]{6,}\d/g, '[phone]'],
  // North American 3-3-4, with or without separators.
  [/(?<![\w+])\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)/g, '[phone]'],
  // Indian national numbers as people write them: 5-5.
  [/(?<![\w+])\d{5}[\s-]\d{5}(?!\w)/g, '[phone]'],
  // Any other long run of digits is a number without its + (919876543210, 14155550123).
  [/(?<![\w+])\d{11,15}(?!\w)/g, '[phone]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email]'],
];

/** `text` with phone numbers, email addresses and credential shapes removed. */
export function redactProviderText(text: string | null | undefined): string {
  let out = String(text ?? '');
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
