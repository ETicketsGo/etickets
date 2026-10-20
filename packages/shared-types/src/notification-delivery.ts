/**
 * What actually happened to a message after it left this platform.
 *
 * ── THE DISTINCTION THIS FILE EXISTS FOR ───────────────────────────────────────────
 * A provider accepting an API call is not a customer receiving a message, and until now the
 * platform could not tell the two apart. `Notification.status` went to SENT the moment SES
 * returned a message id — which means "SES has queued this", not "it arrived". A hard bounce
 * ten seconds later changed nothing; the row still said SENT, and support still had nothing
 * to look at.
 *
 * So acceptance and delivery are separate states, and the only thing that can move a message
 * from one to the other is the provider telling us, through a callback we can verify.
 *
 * ── WHAT EACH STATE MEANS ──────────────────────────────────────────────────────────
 * PENDING     nothing has been attempted yet
 * ATTEMPTING  a provider call is in flight; written BEFORE the call, so a crash leaves a trace
 * ACCEPTED    the provider took it and issued a reference. NOT delivery.
 * DELIVERED   the provider says it reached the handset or the mailbox
 * READ        the recipient opened it (WhatsApp only; nothing else can prove this)
 * FAILED      the send itself failed — a network error, a refusal, a bad credential
 * REJECTED    the provider refused before carrying it (unregistered template, blocked number)
 * UNDELIVERED the provider carried it and could not deliver (handset off, number dead)
 * BOUNCED     the destination is permanently bad (mailbox does not exist)
 * COMPLAINED  the recipient marked it as spam
 * SKIPPED     no provider was called: nowhere to send to, or the destination is suppressed
 * LOGGED      no provider was called: the `log` transport wrote it to the server log
 *
 * SKIPPED and LOGGED are written by this platform, never by a callback. They exist because
 * the attempt row used to say REJECTED for a skip -- "the provider refused it" -- about a
 * message no provider ever saw, and ACCEPTED for a log-mode send that went nowhere.
 *
 * BOUNCED, COMPLAINED and REJECTED are the ones that must stop future traffic to that
 * destination. UNDELIVERED usually must not: a phone that was switched off is a phone that
 * will be switched on again.
 */
export const DeliveryState = {
  PENDING: 'PENDING',
  ATTEMPTING: 'ATTEMPTING',
  ACCEPTED: 'ACCEPTED',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
  REJECTED: 'REJECTED',
  UNDELIVERED: 'UNDELIVERED',
  BOUNCED: 'BOUNCED',
  COMPLAINED: 'COMPLAINED',
  SKIPPED: 'SKIPPED',
  LOGGED: 'LOGGED',
} as const;
export type DeliveryState = (typeof DeliveryState)[keyof typeof DeliveryState];

/**
 * How far along each state is, for resolving out-of-order callbacks.
 *
 * ── WHY PRECEDENCE AND NOT A TRANSITION TABLE ──────────────────────────────────────
 * Provider callbacks do not arrive in order. Twilio's `delivered` and `sent` are two HTTP
 * requests racing each other across the internet, and WhatsApp routinely delivers `read`
 * before `delivered`. A transition table would have to enumerate every out-of-order pair and
 * would still be wrong for the pair nobody thought of.
 *
 * A rank makes the rule one sentence: a message never goes backwards. A late `sent` arriving
 * after `delivered` is not new information, and applying it would tell an operator a message
 * that reached somebody is still in flight.
 *
 * ── WHY TERMINAL FAILURES OUTRANK DELIVERY ─────────────────────────────────────────
 * A bounce says the address does not exist. If it arrives after a `delivered` event — which
 * happens, because "delivered to the receiving server" and "the mailbox rejected it" are
 * different hops — the bounce is the truth, and it is the one that must stop future sends.
 * READ sits above DELIVERED and below the failures for the same reason.
 */
const RANK: Record<DeliveryState, number> = {
  PENDING: 0,
  ATTEMPTING: 1,
  ACCEPTED: 2,
  DELIVERED: 3,
  READ: 4,
  // Terminal outcomes. Above everything, because they are the last word about a destination.
  UNDELIVERED: 5,
  FAILED: 6,
  REJECTED: 7,
  COMPLAINED: 8,
  BOUNCED: 9,
  /*
    Final the moment they are written: no provider holds a reference to these, so no
    callback can arrive about them, and ranking them above every other outcome means a
    stray one could not move them anyway.
  */
  SKIPPED: 10,
  LOGGED: 10,
};

/**
 * The attempt never reached a provider, so nothing was delivered and nothing can be.
 *
 * Kept apart from the failures because a resend of one of these is not a second copy of
 * anything -- the first one went nowhere.
 */
export function wasNotSent(state: DeliveryState | null | undefined): boolean {
  return state === DeliveryState.SKIPPED || state === DeliveryState.LOGGED;
}

/**
 * The statuses a Notification row can hold.
 *
 * -- WHY SKIPPED AND LOGGED EXIST --------------------------------------------------
 * SENT used to cover three different facts: a provider accepted it, there was nobody to send
 * it to, and the log transport printed it. On QA 73 WhatsApp rows said SENT with provider
 * `none` and reason `no_destination`, and every logged email and push said SENT with
 * provider `log` -- so in production "sent" read as delivered for messages that never left.
 * SENT now means a provider (or the in-app inbox) took it; the other two say what happened.
 *
 * Additive: rows written before these existed keep their old status, and readers map them
 * at read time (see the admin delivery summary) rather than anything rewriting history.
 */
export const NotificationStatus = {
  PENDING: 'PENDING',
  SCHEDULED: 'SCHEDULED',
  SENT: 'SENT',
  /** Not sent: nowhere to send to, or the destination is suppressed. `lastError` says which. */
  SKIPPED: 'SKIPPED',
  /** Not sent: the channel runs on the log transport, so it was written to the server log. */
  LOGGED: 'LOGGED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type NotificationStatus = (typeof NotificationStatus)[keyof typeof NotificationStatus];

/** The state that survives when two are known. Never regresses. */
export function resolveDeliveryState(
  current: DeliveryState,
  incoming: DeliveryState,
): DeliveryState {
  return RANK[incoming] > RANK[current] ? incoming : current;
}

/** True when `incoming` would move things on; false for a late duplicate or a regression. */
export function advancesDelivery(current: DeliveryState, incoming: DeliveryState): boolean {
  return RANK[incoming] > RANK[current];
}

/** Nothing further will happen to this attempt. */
export function isTerminalDelivery(state: DeliveryState): boolean {
  return RANK[state] >= RANK.UNDELIVERED || state === DeliveryState.READ;
}

/**
 * Why a destination is being suppressed. Deliberately narrow: only reasons that mean
 * "sending here again is pointless or unwelcome", never a transient failure.
 */
export const SuppressionReason = {
  /** The mailbox does not exist. Every future email to it will bounce too. */
  HARD_BOUNCE: 'HARD_BOUNCE',
  /** Marked as spam. Continuing to send damages the sending domain's reputation. */
  COMPLAINT: 'COMPLAINT',
  /** The recipient replied STOP, or opted out at the provider. A legal instruction. */
  UNSUBSCRIBED: 'UNSUBSCRIBED',
  /** The number or address is not a valid destination and never will be. */
  INVALID_DESTINATION: 'INVALID_DESTINATION',
  /** The provider will not carry messages to this destination at all. */
  BLOCKED_BY_PROVIDER: 'BLOCKED_BY_PROVIDER',
} as const;
export type SuppressionReason = (typeof SuppressionReason)[keyof typeof SuppressionReason];

/**
 * Whether an outcome means "stop sending to this destination", and why.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────
 * UNDELIVERED and FAILED. A handset that was switched off, a mailbox that was temporarily
 * full, a network that dropped a request — none of those say anything about the destination
 * itself, and suppressing on them would quietly stop somebody's tickets from arriving
 * because their phone was in a tunnel once.
 */
export function suppressionFor(state: DeliveryState): SuppressionReason | null {
  switch (state) {
    case DeliveryState.BOUNCED:
      return SuppressionReason.HARD_BOUNCE;
    case DeliveryState.COMPLAINED:
      return SuppressionReason.COMPLAINT;
    case DeliveryState.REJECTED:
      return SuppressionReason.BLOCKED_BY_PROVIDER;
    default:
      return null;
  }
}

/**
 * Whether a failed delivery may be sent again automatically.
 *
 * ── SEND-ATTEMPT RETRY IS NOT POST-ACCEPTANCE FAILURE ──────────────────────────────
 * These are two different things and conflating them costs money.
 *
 * A send attempt that FAILED never reached the provider — a timeout, a 500, a dropped
 * connection. Nobody received anything, so retrying is free and correct, and the existing
 * attempt counter governs it.
 *
 * A delivery that came back UNDELIVERED was ACCEPTED first. The provider took it, charged
 * for it, and tried. Automatically sending it again would be a second message and a second
 * charge, on the guess that the second attempt fares better — and for a phone that is simply
 * switched off it will not. Worse, the carrier may yet deliver the first one, and the
 * customer gets their ticket twice.
 *
 * So nothing that was once accepted is ever resent automatically. An operator can resend,
 * deliberately and audibly, through the admin path.
 */
export function mayAutomaticallyRetry(state: DeliveryState): boolean {
  return state === DeliveryState.PENDING || state === DeliveryState.FAILED;
}
