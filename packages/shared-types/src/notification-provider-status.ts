import { DeliveryState, SuppressionReason } from './notification-delivery';

/**
 * Each provider's own vocabulary, translated into the one lifecycle.
 *
 * ── WHY THE MAPS ARE SEPARATE AND EXPLICIT ─────────────────────────────────────────
 * The words overlap and mean different things. Twilio's `sent` means the carrier has it;
 * SendGrid's `delivered` means the receiving mail server accepted it; WhatsApp's `sent`
 * means Meta has it and nothing more. Guessing from the word — treating anything containing
 * "deliver" as DELIVERED — would map Twilio's `undelivered` to success, which is exactly
 * backwards on the state that matters most.
 *
 * ── WHY AN UNKNOWN STATUS IS NULL AND NOT A GUESS ──────────────────────────────────
 * Providers add statuses. A status this platform has never seen is information it does not
 * have, and the honest response is to record the provider's own string, leave the normalized
 * state where it was, and count it — not to invent a state and act on it.
 */

/**
 * Twilio message statuses. `queued`/`sending` are pre-acceptance; `sent` means the carrier
 * took it; `delivered` is a carrier receipt; `undelivered` means it was carried and did not
 * arrive; `failed` means Twilio could not send it at all.
 */
const TWILIO: Record<string, DeliveryState> = {
  accepted: DeliveryState.ACCEPTED,
  scheduled: DeliveryState.ACCEPTED,
  queued: DeliveryState.ACCEPTED,
  sending: DeliveryState.ACCEPTED,
  sent: DeliveryState.ACCEPTED,
  delivered: DeliveryState.DELIVERED,
  read: DeliveryState.READ,
  undelivered: DeliveryState.UNDELIVERED,
  failed: DeliveryState.FAILED,
  canceled: DeliveryState.REJECTED,
};

/**
 * Meta WhatsApp Cloud statuses. `failed` carries an error code that decides whether the
 * number is permanently unusable or the attempt merely did not land — see
 * {@link metaFailureState}.
 */
const META: Record<string, DeliveryState> = {
  sent: DeliveryState.ACCEPTED,
  delivered: DeliveryState.DELIVERED,
  read: DeliveryState.READ,
  failed: DeliveryState.UNDELIVERED,
  deleted: DeliveryState.UNDELIVERED,
};

/**
 * MSG91 delivery-report statuses. Their reports carry both a numeric code and a description;
 * the numeric codes are the stable part.
 *
 * NOTE: these are read from MSG91's published delivery-report documentation. The codes are
 * configurable-adjacent -- an account can be set up to report differently -- so an unmapped
 * code records the provider's own value rather than guessing, and shows up in the unknown
 * status metric where somebody will notice it.
 */
const MSG91: Record<string, DeliveryState> = {
  '1': DeliveryState.DELIVERED,
  delivered: DeliveryState.DELIVERED,
  '2': DeliveryState.UNDELIVERED,
  failed: DeliveryState.UNDELIVERED,
  '9': DeliveryState.REJECTED,
  blocked: DeliveryState.REJECTED,
  '17': DeliveryState.REJECTED,
  dnd: DeliveryState.REJECTED,
  '16': DeliveryState.REJECTED,
  rejected: DeliveryState.REJECTED,
  '8': DeliveryState.ACCEPTED,
  sent: DeliveryState.ACCEPTED,
  '25': DeliveryState.UNDELIVERED,
  '7': DeliveryState.UNDELIVERED,
  expired: DeliveryState.UNDELIVERED,
  unsubscribed: DeliveryState.REJECTED,
};

/**
 * SES event types, which arrive over SNS. `Delivery` means the receiving mail server accepted
 * it — the furthest anything can prove for email. `Bounce` splits on permanence, which is the
 * whole reason SES events are worth ingesting: a Permanent bounce is a dead address and every
 * future send to it costs sending reputation.
 */
const SES: Record<string, DeliveryState> = {
  Send: DeliveryState.ACCEPTED,
  Delivery: DeliveryState.DELIVERED,
  Complaint: DeliveryState.COMPLAINED,
  Reject: DeliveryState.REJECTED,
  RenderingFailure: DeliveryState.FAILED,
  DeliveryDelay: DeliveryState.ACCEPTED,
  Open: DeliveryState.READ,
  Click: DeliveryState.READ,
};

/** SendGrid event-webhook events, for the adapter that exists but is not in the launch matrix. */
const SENDGRID: Record<string, DeliveryState> = {
  processed: DeliveryState.ACCEPTED,
  deferred: DeliveryState.ACCEPTED,
  delivered: DeliveryState.DELIVERED,
  open: DeliveryState.READ,
  bounce: DeliveryState.BOUNCED,
  dropped: DeliveryState.REJECTED,
  spamreport: DeliveryState.COMPLAINED,
  blocked: DeliveryState.REJECTED,
};

const MAPS: Record<string, Record<string, DeliveryState>> = {
  twilio: TWILIO,
  cloud: META,
  msg91: MSG91,
  ses: SES,
  sendgrid: SENDGRID,
};

/**
 * Normalize one provider status. Returns null when the provider used a word this platform
 * does not know — which is recorded, counted, and left to a human, never guessed at.
 */
export function normalizeProviderStatus(
  provider: string,
  status: string | null | undefined,
): DeliveryState | null {
  const map = MAPS[provider.toLowerCase()];
  if (!map || !status) return null;
  return map[status] ?? map[status.toLowerCase()] ?? null;
}

/**
 * An SES bounce, which is two different facts wearing one name.
 *
 * `Permanent` means the address does not exist and never will; every further send to it is
 * a bounce charged against the sending domain's reputation, which is what gets an account
 * throttled or suspended. `Transient` is a full mailbox or a greylisting server, and
 * suppressing on it would stop somebody's tickets because their inbox was full on Tuesday.
 */
export function sesBounceState(bounceType: string | null | undefined): DeliveryState {
  return bounceType === 'Permanent' ? DeliveryState.BOUNCED : DeliveryState.UNDELIVERED;
}

/**
 * A Meta WhatsApp failure, which is likewise two facts.
 *
 * 131026 is "message undeliverable" — the number is not on WhatsApp, which is permanent for
 * this channel. 131047 is a re-engagement window error and 131056 a pair rate limit, both of
 * which are about timing rather than the destination. 131031 is an account-level block.
 * Everything else is treated as an attempt that did not land.
 */
const META_PERMANENT = new Set(['131026', '131031', '131049', '132000', '132001']);

export function metaFailureState(errorCode: string | number | null | undefined): DeliveryState {
  return META_PERMANENT.has(String(errorCode)) ? DeliveryState.REJECTED : DeliveryState.UNDELIVERED;
}

/**
 * A Twilio error code that means the destination itself is unusable, rather than the attempt
 * having gone badly.
 *
 * 21211 invalid number, 21610 the recipient replied STOP, 21612/21614 not reachable or not a
 * mobile. 30003 (unreachable handset) and 30005 (unknown destination) are deliberately NOT
 * here: a switched-off phone comes back on.
 */
const TWILIO_PERMANENT: Record<string, DeliveryState> = {
  '21211': DeliveryState.REJECTED,
  '21610': DeliveryState.REJECTED,
  '21612': DeliveryState.REJECTED,
  '21614': DeliveryState.REJECTED,
  '30006': DeliveryState.REJECTED,
};

export function twilioFailureState(
  status: string,
  errorCode: string | number | null | undefined,
): DeliveryState {
  const permanent = errorCode != null ? TWILIO_PERMANENT[String(errorCode)] : undefined;
  if (permanent) return permanent;
  return TWILIO[status] ?? DeliveryState.UNDELIVERED;
}

/**
 * Whether a Twilio error code is an explicit opt-out (STOP), which is a legal instruction
 * rather than a delivery outcome and must suppress the destination on its own.
 */
export function isTwilioOptOut(errorCode: string | number | null | undefined): boolean {
  return String(errorCode) === '21610';
}

/**
 * The suppression reason when a provider's failure IS the recipient opting out.
 *
 * ── WHY THIS IS NOT JUST ANOTHER REJECTION ─────────────────────────────────────────
 * A recipient replying STOP is a legal instruction about that person, and it has to be
 * recorded as one. Filed under BLOCKED_BY_PROVIDER it is indistinguishable from a carrier
 * refusing a dead number: an operator lifting "provider blocks" after a carrier incident
 * would quietly resume texting somebody who asked us to stop, and nothing on the row would
 * have said otherwise.
 *
 * Returns null for everything else, so the state's own suppression (if any) stands.
 */
export function providerOptOut(
  provider: string,
  codeOrStatus: string | number | null | undefined,
): SuppressionReason | null {
  if (codeOrStatus === null || codeOrStatus === undefined) return null;
  const value = String(codeOrStatus).trim().toLowerCase();
  switch (provider.toLowerCase()) {
    case 'twilio':
      return isTwilioOptOut(value) ? SuppressionReason.UNSUBSCRIBED : null;
    case 'msg91':
      return value === 'unsubscribed' ? SuppressionReason.UNSUBSCRIBED : null;
    default:
      return null;
  }
}
