import { marketsForE164 } from '@eticketsgo/shared-types';
import { RenderedNotification } from '../notification-channel.interface';

/**
 * Reads a non-empty string `payload.phone` (E.164), or undefined when absent.
 *
 * ── WHY THIS IS NO LONGER THE MAIN ANSWER ──────────────────────────────────────────
 * It was the ONLY answer, and its own comment explained why that was safe: "the platform
 * does not collect phone numbers yet". That stopped being true when phone sign-in shipped —
 * `User.phone` is now a unique column and the identity most Indian buyers sign in with — but
 * nothing here changed, and no caller ever put a phone in a payload. The result was that
 * every SMS and every WhatsApp message this platform has ever sent was silently skipped.
 *
 * A payload is now the FALLBACK, for the one case that genuinely has no account to look up:
 * a sign-in code being sent to a number that may not belong to anybody yet.
 */
export function payloadPhone(msg: RenderedNotification): string | undefined {
  const phone = msg.payload?.['phone'];
  return typeof phone === 'string' && phone.length > 0 ? phone : undefined;
}

/**
 * Where an SMS or WhatsApp message is actually going.
 *
 * The resolved `destination` — read by the channel from the recipient's own account — beats
 * the payload, always. Getting that order right is the difference between a payload being
 * data and a payload being an instruction: with the payload first, any service that could
 * put a string in a payload could redirect somebody else's booking confirmation to a number
 * of its choosing, and the notification would look entirely normal in the database.
 */
export function resolveDestination(msg: RenderedNotification): string | undefined {
  if (typeof msg.destination === 'string' && msg.destination.length > 0) return msg.destination;
  return payloadPhone(msg);
}

/**
 * A phone number as it may appear in a log line: country code, then the last two digits.
 *
 * Enough to tell two recipients apart while reading a support thread, and enough to see
 * which market a message was routed to. Not enough to be a phone number. Logs are shipped
 * to a third party and kept for months; a full number in one is a full number in all of them.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return 'n/a';
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 4) return '***';
  /*
    The calling code comes from the same table the router uses, rather than a guess at how
    many leading digits to keep. Guessing gets +1 and +91 wrong in opposite directions, and
    the country code is the half of this that is actually useful to read.
  */
  const markets = marketsForE164(phone);
  const code = markets.length > 0 ? CALLING_CODE_FOR[markets[0]] : undefined;
  return `${code ? `+${code}` : ''}***${digits.slice(-2)}`;
}

/** Calling code per market, for masking only. Mirrors the routing table's own list. */
const CALLING_CODE_FOR: Record<string, string> = {
  IN: '91',
  US: '1',
  CA: '1',
  GB: '44',
  AE: '971',
  SG: '65',
  AU: '61',
  NZ: '64',
};

/**
 * Reads push device token(s) from the payload: `payload.pushToken` (string) or
 * `payload.pushTokens` (string[]). Returns a de-duplicated, non-empty list, or an
 * empty array when none are present (a clean skip for the push transport).
 */
export function payloadPushTokens(msg: RenderedNotification): string[] {
  const tokens = new Set<string>();
  const single = msg.payload?.['pushToken'];
  if (typeof single === 'string' && single.length > 0) tokens.add(single);
  const many = msg.payload?.['pushTokens'];
  if (Array.isArray(many)) {
    for (const t of many) if (typeof t === 'string' && t.length > 0) tokens.add(t);
  }
  return [...tokens];
}
