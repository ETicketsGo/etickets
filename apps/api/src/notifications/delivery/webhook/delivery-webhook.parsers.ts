import {
  DeliveryState,
  metaFailureState,
  normalizeProviderStatus,
  providerOptOut,
  sesBounceState,
  twilioFailureState,
  type SuppressionReason,
} from '@eticketsgo/shared-types';

/**
 * Turning each provider's callback into the same three facts: which message, what happened,
 * and — when the news is terminal — which destination should stop receiving traffic.
 *
 * ── WHY PARSING IS SEPARATE FROM APPLYING ──────────────────────────────────────────
 * These are pure functions over a parsed body. That makes the interesting cases — a
 * malformed payload, an unknown status, a bounce with three recipients — testable without a
 * database, a signature, or an HTTP server, and it keeps the part that decides what a
 * provider MEANT away from the part that decides what to write down.
 */

/** One thing a provider told us about one message. */
export interface DeliveryEvent {
  /** The provider's own reference for the message, as issued at send time. */
  providerMessageId: string;
  state: DeliveryState;
  /** The provider's own word, kept verbatim for an operator to read. */
  providerStatus?: string | null;
  failureCode?: string | null;
  failureReason?: string | null;
  /**
   * The destination, present only when the event is terminal and suppression may follow.
   * Hashed the moment it is used; never stored in the clear.
   */
  destination?: string | null;
  /**
   * Why the destination must stop receiving traffic, when the event says more than its state
   * does. A STOP arrives as an ordinary REJECTED; this is what records it as the opt-out it is.
   */
  suppressionReason?: SuppressionReason | null;
  occurredAt?: Date;
  /** A provider-unique id for this EVENT, for replay protection. */
  eventId: string;
}

/** Safely read a nested value without letting a malformed body throw. */
function at(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Twilio posts a form body per status change: MessageSid, MessageStatus, and ErrorCode when
 * something went wrong.
 *
 * The error code is what separates "the handset was off" from "the number does not exist",
 * and only the second may suppress. 21610 is a STOP reply, which is a legal instruction
 * rather than a delivery outcome and is treated as an opt-out.
 */
export function parseTwilio(body: Record<string, unknown>): DeliveryEvent | null {
  const sid = str(body.MessageSid) ?? str(body.SmsSid);
  const status = str(body.MessageStatus) ?? str(body.SmsStatus);
  if (!sid || !status) return null;

  const errorCode = str(body.ErrorCode);
  const state =
    status === 'failed' || status === 'undelivered'
      ? twilioFailureState(status, errorCode)
      : (normalizeProviderStatus('twilio', status) ?? DeliveryState.ACCEPTED);

  return {
    // Twilio does not send an event id; the message and its status together are unique
    // enough for replay protection, since the same status never legitimately repeats.
    eventId: `${sid}:${status}`,
    providerMessageId: sid,
    state,
    providerStatus: status,
    failureCode: errorCode,
    // `To` is on the callback and is exactly the destination that would be suppressed.
    destination: str(body.To),
    suppressionReason: providerOptOut('twilio', errorCode),
  };
}

/** Twilio Advanced Opt-Out's three classifications of an inbound message. */
export type OptOutKeyword = 'STOP' | 'START' | 'HELP';

/** An inbound message Twilio classified as an opt-out keyword. */
export interface InboundOptOutEvent {
  /** The inbound message's own SID. One inbound message is one event. */
  messageSid: string;
  optOutType: OptOutKeyword;
  /** Who sent the keyword. Reduced to a hash before anything is stored or acted on. */
  from: string;
}

/**
 * An inbound SMS to the Messaging Service, reduced to the one fact this platform acts on.
 *
 * ── WHY ONLY `OptOutType`, AND NEVER THE BODY ──────────────────────────────────────
 * With Advanced Opt-Out enabled, Twilio classifies the message itself -- against its default
 * keywords, the account's custom keywords, and their per-language variants -- replies to the
 * sender, and blocks or unblocks the number at the Messaging Service. It then tells the webhook
 * what it decided in `OptOutType`: STOP, START or HELP.
 *
 * Twilio is the authority on that decision, because Twilio is what enforces it. Matching the
 * body here would be a second keyword list that disagrees with Twilio's the first time a
 * keyword is customised, and it would mean reading what a customer wrote to us. A message
 * without `OptOutType` is not an opt-out as far as Twilio is concerned, so it is not one here.
 */
export function parseTwilioInbound(body: Record<string, unknown>): InboundOptOutEvent | null {
  const messageSid = str(body.MessageSid) ?? str(body.SmsMessageSid) ?? str(body.SmsSid);
  const from = str(body.From);
  const type = str(body.OptOutType)?.trim().toUpperCase();
  if (!messageSid || !from) return null;
  if (type !== 'STOP' && type !== 'START' && type !== 'HELP') return null;
  return { messageSid, optOutType: type, from };
}

/**
 * Meta's WhatsApp Cloud webhook nests statuses under entry[].changes[].value.statuses[].
 * One POST can carry several, for several messages.
 */
export function parseMetaCloud(body: unknown): DeliveryEvent[] {
  const events: DeliveryEvent[] = [];
  const entries = at(body, 'entry');
  if (!Array.isArray(entries)) return events;

  for (const entry of entries) {
    const changes = at(entry, 'changes');
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const statuses = at(change, 'value', 'statuses');
      if (!Array.isArray(statuses)) continue;
      for (const s of statuses) {
        const id = str(at(s, 'id'));
        const status = str(at(s, 'status'));
        if (!id || !status) continue;
        const errorCode = at(s, 'errors', 0, 'code');
        const state =
          status === 'failed'
            ? metaFailureState(errorCode as string | number | null)
            : (normalizeProviderStatus('cloud', status) ?? DeliveryState.ACCEPTED);
        const ts = str(at(s, 'timestamp'));
        events.push({
          eventId: `${id}:${status}`,
          providerMessageId: id,
          state,
          providerStatus: status,
          failureCode: errorCode != null ? String(errorCode) : null,
          failureReason: str(at(s, 'errors', 0, 'title')),
          destination: str(at(s, 'recipient_id')),
          // Meta sends seconds since epoch as a string.
          occurredAt: ts ? new Date(Number(ts) * 1000) : undefined,
        });
      }
    }
  }
  return events;
}

/**
 * MSG91 delivery reports.
 *
 * Their report shape is account-configurable, which is why this reads several spellings of
 * the same field rather than one. An unmapped status code leaves the normalized state alone
 * and preserves the provider's own value — a code nobody has seen is information we do not
 * have, not a licence to guess.
 */
export function parseMsg91(body: Record<string, unknown>): DeliveryEvent | null {
  const id = str(body.requestId) ?? str(body.request_id) ?? str(body.messageId);
  if (!id) return null;
  const status = str(body.status) ?? str(body.statusCode) ?? str(body.deliveryStatus);
  if (!status) return null;

  const state = normalizeProviderStatus('msg91', status);
  if (!state) return null;

  return {
    eventId: `${id}:${status}`,
    providerMessageId: id,
    state,
    providerStatus: status,
    failureCode: str(body.errCode) ?? str(body.errorCode),
    failureReason: str(body.description) ?? str(body.desc),
    destination: str(body.number) ?? str(body.mobile) ?? str(body.recipient),
    suppressionReason: providerOptOut('msg91', status),
  };
}

/**
 * Which timestamp an SES event actually happened at.
 *
 * ── WHY `mail.timestamp` WAS THE WRONG ANSWER FOR EVERYTHING ───────────────────────
 * Every SES event carries a `mail` envelope describing the ORIGINAL SEND, and using its
 * timestamp for all of them means every event is dated to the moment the message was handed
 * to SES rather than the moment the thing happened.
 *
 * That is not a rounding error. `occurredAt` becomes `deliveredAt` on the delivery row, and in
 * the QA certification run it recorded 00:44:00.856 for a message our own clock accepted at
 * 00:44:01.139 — a delivery stamped BEFORE the send it followed. At those speeds it looks like
 * clock skew and nobody investigates. For a message greylisted for four hours, or a bounce a
 * receiving server reports the next morning, the row would claim it all happened at send time,
 * and the interval between accepting a message and learning its fate — the one number that
 * says whether a destination is slow or broken — would always read as zero.
 *
 * ── WHY THE FALLBACK IS STILL `mail.timestamp` ─────────────────────────────────────
 * AWS gives some event types their own timestamp and some none at all: `Reject` carries only a
 * reason, `RenderingFailure` only an error, `Send` an empty object. For those the envelope
 * time is genuinely the best available fact, so it is used deliberately rather than leaving
 * the event undated — an event with no time at all is worse than one timed to its send.
 */
function sesOccurredAt(message: unknown, type: string): Date | undefined {
  /*
    The event-specific field, where AWS publishes one. Named per type rather than searched for,
    because guessing at "whichever nested object has a timestamp" would silently pick up a new
    field AWS adds later for something else entirely.
  */
  const OWN_TIMESTAMP: Record<string, string> = {
    Delivery: 'delivery',
    Bounce: 'bounce',
    Complaint: 'complaint',
    DeliveryDelay: 'deliveryDelay',
    Open: 'open',
    Click: 'click',
    // Reject, RenderingFailure and Send publish no timestamp of their own; they fall through
    // to the envelope below, which is the honest best available.
  };

  const own = OWN_TIMESTAMP[type];
  const specific = own ? str(at(message, own, 'timestamp')) : null;
  const envelope = str(at(message, 'mail', 'timestamp'));

  for (const candidate of [specific, envelope]) {
    if (!candidate) continue;
    const parsed = new Date(candidate);
    // A malformed timestamp must not become an Invalid Date on a row: fall through to the
    // envelope, and to undefined if that is bad too, so the recorder stamps its own clock.
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

/**
 * SES events, which arrive wrapped in an SNS notification.
 *
 * ── WHY THE BOUNCE TYPE MATTERS MORE THAN THE EVENT TYPE ───────────────────────────
 * `Bounce` is two different facts wearing one name. Permanent means the mailbox does not
 * exist and every further send to it is charged against the sending domain's reputation —
 * which is what gets an account throttled. Transient is a full mailbox or a greylisting
 * server, and suppressing on it would stop somebody's tickets because their inbox was full
 * on a Tuesday.
 *
 * One SES bounce can name several recipients. Each becomes its own event, because each is a
 * separate destination that may or may not need suppressing.
 */
export function parseSesEvent(message: unknown): DeliveryEvent[] {
  const type = str(at(message, 'eventType')) ?? str(at(message, 'notificationType'));
  const messageId = str(at(message, 'mail', 'messageId'));
  if (!type || !messageId) return [];

  const occurredAt = sesOccurredAt(message, type);
  const base = { providerMessageId: messageId, providerStatus: type, occurredAt };

  if (type === 'Bounce') {
    const bounceType = str(at(message, 'bounce', 'bounceType'));
    const state = sesBounceState(bounceType);
    const recipients = at(message, 'bounce', 'bouncedRecipients');
    const list = Array.isArray(recipients) ? recipients : [];
    if (list.length === 0) {
      return [{ ...base, eventId: `${messageId}:Bounce`, state, failureCode: bounceType }];
    }
    return list.map((r, i) => ({
      ...base,
      eventId: `${messageId}:Bounce:${i}`,
      state,
      failureCode: bounceType,
      failureReason: str(at(r, 'diagnosticCode')),
      destination: str(at(r, 'emailAddress')),
    }));
  }

  if (type === 'Complaint') {
    const recipients = at(message, 'complaint', 'complainedRecipients');
    const list = Array.isArray(recipients) ? recipients : [];
    return (list.length ? list : [null]).map((r, i) => ({
      ...base,
      eventId: `${messageId}:Complaint:${i}`,
      state: DeliveryState.COMPLAINED,
      failureCode: str(at(message, 'complaint', 'complaintFeedbackType')),
      destination: r ? str(at(r, 'emailAddress')) : null,
    }));
  }

  const state = normalizeProviderStatus('ses', type);
  if (!state) return [];
  const recipients = at(message, 'mail', 'destination');
  return [
    {
      ...base,
      eventId: `${messageId}:${type}`,
      state,
      destination: Array.isArray(recipients) ? str(recipients[0]) : null,
    },
  ];
}
