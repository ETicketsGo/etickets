import { NotificationType } from '@eticketsgo/shared-types';

/** The set of delivery channels the platform knows about. */
export type ChannelKey = 'email' | 'sms' | 'whatsapp' | 'push' | 'in_app';

/**
 * A fully rendered notification ready for delivery on a single channel. The
 * template service produces `subject`/`body`; the raw `payload` is passed
 * through so channels/providers can build richer messages if needed.
 */
export interface RenderedNotification {
  type: NotificationType;
  channel: ChannelKey;
  locale: string;
  toEmail?: string | null;
  userId?: string | null;
  subject: string;
  body: string;
  payload: Record<string, unknown>;
  /**
   * The resolved E.164 destination for SMS/WhatsApp, put here by the channel from the
   * recipient's own account record.
   *
   * It is a field of its own rather than something stuffed into `payload` because the two
   * have different authority: a payload is assembled by whichever service is sending, and
   * this is where the message is actually going. When a recipient has an account, this wins
   * over anything a payload says — otherwise a payload could redirect somebody's booking
   * confirmation to a number of its choosing.
   */
  destination?: string | null;
  /**
   * The market this message is being delivered INTO, when the sender knows it from trusted
   * business data. Used only to choose a provider; never supplied by a client.
   */
  country?: string | null;
}

/**
 * What came back from one delivery attempt.
 *
 * ── WHY `deliver` NO LONGER RETURNS void ───────────────────────────────────────────
 * It used to, and so the only thing the platform could record about a send was that it had
 * not thrown. With two SMS providers live in different markets that is not enough to answer
 * either of the questions that actually get asked — "did it go?" and "who carried it?" — so
 * an attempt now reports the provider that handled it and the reference that provider issued.
 *
 * `skipped` is the third outcome, and it is not a failure: a push to somebody with no
 * registered device, or an SMS to somebody with no phone number, is a message that correctly
 * did not go anywhere. Recording it as SENT would be a lie and as FAILED would trigger
 * retries of something that can never succeed.
 */
export interface DeliveryOutcome {
  /** The provider that handled it (`ses`, `msg91`, `twilio`, `log`, `in_app`, …). */
  provider: string;
  /** The provider's own message reference, when it gives one. */
  providerMessageId?: string | null;
  /** True when there was nothing to deliver to. Never counts as a failure. */
  skipped?: boolean;
  /** Why it was skipped — never contains a destination or any message content. */
  reason?: string;
}

/** A delivery channel: renders nothing, decides nothing, just gets a message out. */
export interface NotificationChannel {
  readonly key: ChannelKey;
  deliver(msg: RenderedNotification): Promise<DeliveryOutcome>;
}
