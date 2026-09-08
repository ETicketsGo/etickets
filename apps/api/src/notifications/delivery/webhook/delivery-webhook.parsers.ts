import {
  DeliveryState,
  metaFailureState,
  normalizeProviderStatus,
  sesBounceState,
  twilioFailureState,
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
  };
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
  };
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

  const timestamp = str(at(message, 'mail', 'timestamp'));
  const occurredAt = timestamp ? new Date(timestamp) : undefined;
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
