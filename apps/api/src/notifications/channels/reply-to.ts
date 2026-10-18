import { NotificationType, isReservedEmail } from '@eticketsgo/shared-types';

/**
 * Which emails may carry a Reply-To, and the address it may be.
 *
 * ── WHY ANY MESSAGE HAS ONE ────────────────────────────────────────────────────────
 * The copy of a Contact or Help form message goes to the support mailbox from the platform's
 * own no-reply sender. Without a Reply-To, "Reply" in Outlook answers the no-reply address and
 * the person who wrote never hears back. With it, a reply goes straight to them.
 *
 * ── WHY IT IS AN ALLOWLIST ─────────────────────────────────────────────────────────
 * The address comes from a public form, so it is the one place user input reaches a mail
 * header. Only the types below may have one, and every other message keeps replies on the
 * From address exactly as before. No other header is ever taken from a payload.
 */
const REPLY_TO_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  // Reply-To is the person who wrote, so Outlook's "Reply" answers them.
  NotificationType.SUPPORT_REQUEST_RECEIVED,
  // Reply-To is the support mailbox, so a reply to "we have your message" reaches a person.
  NotificationType.SUPPORT_REQUEST_ACKNOWLEDGED,
]);

/**
 * One plain address: no display name, no list, no whitespace, no line breaks.
 *
 * Deliberately stricter than RFC 5322. A comma, an angle bracket, a quote or a CR/LF is how a
 * second recipient or a second header is smuggled into a header value; none of them is in a
 * real address anybody types into a contact form.
 */
const PLAIN_ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** True for an address that is safe to put in a Reply-To header. */
export function isSafeReplyTo(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    PLAIN_ADDRESS.test(value) &&
    // A phone-only account's placeholder is not a mailbox; a reply to it would bounce.
    !isReservedEmail(value)
  );
}

/** The Reply-To for this message, or null when it has none or the address is not safe. */
export function replyToFor(
  type: NotificationType,
  payload: Record<string, unknown> | undefined,
): string | null {
  if (!REPLY_TO_TYPES.has(type)) return null;
  const candidate = payload?.['replyTo'];
  return isSafeReplyTo(candidate) ? candidate : null;
}
