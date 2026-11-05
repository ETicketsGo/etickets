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
  /**
   * The HTML alternative, for email only.
   *
   * Set by the email channel just before delivery, never by a producer: SMS, push and the
   * in-app list read `body`, and a message that carried markup in the field they read would
   * put tags on somebody's lock screen. Absent means "send the text alone", which is what
   * the log transport and every non-email channel do.
   */
  html?: string | null;
  /**
   * The Reply-To address, for email only, and only for the types allowed one.
   *
   * Set by the email channel from `reply-to.ts`, never by a producer directly: it is the one
   * header a payload may influence, so the type allowlist and the address check live in one
   * place. Absent means replies go to the From address, which is every other message.
   */
  replyTo?: string | null;
  /**
   * RFC 2369 / RFC 8058 unsubscribe headers, for email only.
   *
   * A narrow, typed field rather than a free `headers` map: these two are the only custom
   * headers any message may carry, and a general map filled from a payload would let any
   * producer set any header under our name. Built by `buildUnsubscribeLinks`
   * (engagement/unsubscribe-token.ts) and set only for marketing mail. No producer sets it
   * today; transactional mail must never carry it.
   */
  listUnsubscribe?: { 'List-Unsubscribe': string; 'List-Unsubscribe-Post'?: string } | null;
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
