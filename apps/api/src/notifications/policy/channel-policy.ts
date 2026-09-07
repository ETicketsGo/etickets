import { NotificationType } from '@eticketsgo/shared-types';
import type { ChannelKey } from '../channels/notification-channel.interface';

/**
 * Which channels each kind of message is allowed to go out on.
 *
 * ── WHY THIS HAD TO EXIST BEFORE THE RECIPIENT FIX ─────────────────────────────────
 * SMS and WhatsApp have never reached anybody: both transports read the recipient from
 * `payload.phone`, and no caller has ever put a phone number there. Fixing that in isolation
 * would have been the most expensive one-line change in the platform's history — every
 * notification type would have started sending real SMS to real numbers the moment the fix
 * shipped, including every share-viewed notice and every admin approval, at per-message cost
 * and with no product decision behind any of it.
 *
 * So enablement is explicit, per message type, here. A type that is not listed cannot use
 * SMS or WhatsApp at all, whatever a caller asks for. Being unable to reach somebody is a
 * bug; being able to reach everybody by accident is a bill.
 *
 * ── WHY `in_app` IS ON EVERYTHING ──────────────────────────────────────────────────
 * The in-app row IS the notification centre. Dropping it from a type would empty that type
 * out of the inbox, which is a visible product regression rather than a policy choice, so
 * every entry carries it and {@link channelsFor} adds it back if an entry ever forgets.
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────────────
 * Sign-in codes. Phone OTP deliberately bypasses NotificationService entirely so a live
 * credential is never written to a queryable `Notification.payload` — see PhoneOtpService.
 * It is already SMS-only and stays that way. WhatsApp OTP fallback is NOT implemented:
 * making it safe means deciding what happens when the first channel silently succeeds but
 * the code never arrives, and inventing that here would be inventing an authentication
 * behaviour the auth architecture has not agreed to.
 */

const E: ChannelKey = 'email';
const A: ChannelKey = 'in_app';
const P: ChannelKey = 'push';
const S: ChannelKey = 'sms';
const W: ChannelKey = 'whatsapp';

/**
 * Every type this platform sends, and the channels it may use. Types absent from this table
 * fall back to {@link FALLBACK_CHANNELS}, which is email + inbox + push — today's behaviour,
 * and never SMS or WhatsApp.
 */
export const CHANNEL_POLICY: Partial<Record<NotificationType, readonly ChannelKey[]>> = {
  /*
    A confirmed booking is the ticket. WhatsApp is how an Indian buyer expects to receive it,
    and push reaches the app where the ticket actually lives. No SMS: the message is long,
    carries a link, and the same information arrives free on three other channels.
  */
  [NotificationType.BOOKING_CONFIRMED]: [E, A, P, W],

  /*
    A cancelled booking is what a customer sees when a show is called off. It is the one
    message worth paying for on every channel including SMS: it is time-critical, it may be
    the difference between somebody travelling to a closed venue or not, and SMS is the only
    channel that reaches a phone with no app, no data and no email set up.
  */
  [NotificationType.BOOKING_CANCELLED]: [E, A, P, W, S],

  /* Money owed back. Email is the record; WhatsApp is where people ask "did it come through". */
  [NotificationType.REFUND_COMPLETED]: [E, A, P, W],

  /* A failure the customer must act on — email for the detail, push to catch them now. */
  [NotificationType.PAYMENT_FAILED]: [E, A, P],

  /*
    A reminder is a courtesy, not a record, so it does not go to email — an inbox full of
    "your show is tomorrow" is how people learn to ignore the sender.
  */
  [NotificationType.EVENT_REMINDER]: [A, P, W],

  /* Organizer money. Their console and their email; not their WhatsApp, not at 3am. */
  [NotificationType.SETTLEMENT_RELEASED]: [E, A],
};

/** Email + inbox + push: what every notification did before this table existed. */
export const FALLBACK_CHANNELS: readonly ChannelKey[] = [E, A, P];

/**
 * The channels a type may use. `in_app` is always included so the notification centre never
 * loses a message to a policy edit.
 */
export function channelsFor(type: NotificationType): ChannelKey[] {
  const declared = CHANNEL_POLICY[type] ?? FALLBACK_CHANNELS;
  return declared.includes('in_app') ? [...declared] : [...declared, 'in_app'];
}

/**
 * Narrow an explicit caller request down to what policy permits.
 *
 * A caller that names channels is expressing a real intent — the settlement service asks for
 * `['in_app','email']` because an organizer payout notice has no business on a customer's
 * push feed — so its list is honoured, minus anything policy does not allow for that type.
 * The result is that a caller can always ask for LESS than policy, never more.
 */
export function permittedChannels(type: NotificationType, requested?: string[]): ChannelKey[] {
  const allowed = channelsFor(type);
  if (!requested) return allowed;
  return allowed.filter((c) => requested.includes(c));
}
