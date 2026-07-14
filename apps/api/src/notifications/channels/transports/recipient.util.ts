import { RenderedNotification } from '../notification-channel.interface';

/**
 * Reads a non-empty string `payload.phone` (E.164) as the SMS/WhatsApp recipient,
 * or undefined when absent. The platform does not collect phone numbers yet, so
 * callers treat `undefined` as a clean skip (warn + return), never an error.
 */
export function payloadPhone(msg: RenderedNotification): string | undefined {
  const phone = msg.payload?.['phone'];
  return typeof phone === 'string' && phone.length > 0 ? phone : undefined;
}

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
