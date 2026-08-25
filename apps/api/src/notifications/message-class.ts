import { NotificationType } from '@eticketsgo/shared-types';

/**
 * Whether a message is something the customer ASKED FOR by transacting, or something the
 * platform wants to send them.
 *
 * ── WHY THIS IS A HARD DISTINCTION AND NOT A PREFERENCE FLAG ───────────────────────
 * Several regimes treat the two categories completely differently, and Canada's
 * anti-spam law is the strictest of the markets in play: a commercial electronic message
 * needs consent that can be produced on demand, while a message about a transaction the
 * person already entered into does not. India's DPDP framework draws a comparable line
 * around purpose.
 *
 * The consequence for engineering is concrete and cuts both ways:
 *
 *   - A TRANSACTIONAL message must go out even if the person has opted out of everything.
 *     Suppressing a ticket, a refund confirmation or a cancellation because somebody
 *     unticked a marketing box is a product failure that looks like a legal precaution.
 *   - A MARKETING message must NOT go out without a recorded, provable consent. Not
 *     "no objection on file" — an affirmative record with a timestamp and a source.
 *
 * A single boolean preference cannot express that, because it makes both categories
 * suppressible and both categories sendable. So the class is a property of the message
 * TYPE, decided here, in one place, and the send path enforces it.
 *
 * ── WHY THE MAP IS EXHAUSTIVE ──────────────────────────────────────────────────────
 * `Record<NotificationType, MessageClass>` means adding a notification type will not
 * compile until somebody classifies it. That is deliberate: the failure we are guarding
 * against is a promotional message added later that inherits a transactional default and
 * is sent to people who never consented. Making it a compile error puts the decision in
 * front of the person adding the type, at the moment they add it.
 */
export type MessageClass = 'TRANSACTIONAL' | 'MARKETING';

export const MESSAGE_CLASS: Record<NotificationType, MessageClass> = {
  // ── The customer's own transaction ──────────────────────────────────────────────
  [NotificationType.BOOKING_CONFIRMED]: 'TRANSACTIONAL',
  [NotificationType.PAYMENT_FAILED]: 'TRANSACTIONAL',
  [NotificationType.BOOKING_CANCELLED]: 'TRANSACTIONAL',
  [NotificationType.REFUND_COMPLETED]: 'TRANSACTIONAL',
  [NotificationType.TICKET_CHECKED_IN]: 'TRANSACTIONAL',
  [NotificationType.TICKET_TRANSFERRED]: 'TRANSACTIONAL',

  /*
    A reminder about an event you hold a ticket for is transactional: it concerns a
    transaction already entered into and carries information you need in order to use what
    you paid for. It stops being transactional the moment it carries anything promotional —
    "and here are three other shows you might like" — which is exactly why the class lives
    with the type rather than being decided per message at the call site.
  */
  [NotificationType.EVENT_REMINDER]: 'TRANSACTIONAL',

  // ── Something another person did that involves this person's ticket ─────────────
  [NotificationType.ATTENDEE_INVITED]: 'TRANSACTIONAL',
  [NotificationType.ATTENDEE_ACCEPTED]: 'TRANSACTIONAL',
  [NotificationType.ATTENDEE_DECLINED]: 'TRANSACTIONAL',
  [NotificationType.SHARE_CREATED]: 'TRANSACTIONAL',
  [NotificationType.SHARE_VIEWED]: 'TRANSACTIONAL',
  [NotificationType.SHARE_REVOKED]: 'TRANSACTIONAL',

  /*
    Onboarding and approval lifecycle (added with the notification work in #51).

    All six are transactional, and the reasoning is the same for each: every one concerns an
    action the recipient either took themselves or must now act on. An organizer being told
    their application was approved is being told the outcome of something they submitted; an
    admin being told a new organizer registered is being handed a queue item. None of them
    promotes anything, and none may be suppressed by a marketing preference — an approval
    notice that never arrives leaves somebody waiting on a decision that was already made.
  */
  [NotificationType.ORGANIZATION_REGISTERED]: 'TRANSACTIONAL',
  [NotificationType.ORGANIZATION_APPROVED]: 'TRANSACTIONAL',
  [NotificationType.ORGANIZATION_REJECTED]: 'TRANSACTIONAL',
  [NotificationType.EVENT_SUBMITTED]: 'TRANSACTIONAL',
  [NotificationType.EVENT_APPROVED]: 'TRANSACTIONAL',
  [NotificationType.EVENT_REJECTED]: 'TRANSACTIONAL',

  // ── Operational messages to organizers and admins about their own money ─────────
  [NotificationType.PAYOUT_ACCOUNT_UPDATED]: 'TRANSACTIONAL',
  [NotificationType.SETTLEMENT_RELEASED]: 'TRANSACTIONAL',
  [NotificationType.PAYMENT_DISPUTE_OPENED]: 'TRANSACTIONAL',
  [NotificationType.PAYMENT_DISPUTE_CLOSED]: 'TRANSACTIONAL',
  [NotificationType.TRANSFER_FAILED]: 'TRANSACTIONAL',
};

export function messageClassOf(type: NotificationType): MessageClass {
  // Falls back to MARKETING, not TRANSACTIONAL, for a type somehow absent from the map.
  // An unclassified message is one nobody has thought about, and the safe reading of "we
  // do not know what this is" is "do not send it to people who did not ask".
  return MESSAGE_CLASS[type] ?? 'MARKETING';
}

/** True when the message must be delivered regardless of marketing preferences. */
export function isTransactional(type: NotificationType): boolean {
  return messageClassOf(type) === 'TRANSACTIONAL';
}

/**
 * Every type the platform currently sends is transactional.
 *
 * That is worth stating out loud rather than leaving to be inferred from the map: the
 * platform has no promotional messaging today, so the consent machinery guards a door
 * nobody is yet walking through. It is built now because the alternative — adding the
 * first marketing message and the consent system in the same change, under launch
 * pressure — is how consent systems end up as a checkbox nobody records.
 */
export const MARKETING_TYPES: NotificationType[] = (
  Object.keys(MESSAGE_CLASS) as NotificationType[]
).filter((t) => MESSAGE_CLASS[t] === 'MARKETING');

/**
 * Which hat somebody is wearing when a message is for them.
 *
 * ── WHY THIS IS A SECOND AXIS ──────────────────────────────────────────────────────
 * Reported from QA: the organizer console's notification list showed the operator's own
 * ticket purchases. One person, one account, two roles — and the inbox was keyed on user id
 * alone, so both streams arrived in both places.
 *
 * This is orthogonal to MessageClass. "Transactional vs commercial" answers *may we send
 * this*; audience answers *where does it belong once sent*. A payout notice and a ticket
 * confirmation are both transactional and belong on entirely different screens.
 *
 * ADMIN is separate from ORGANIZER rather than folded into it: platform moderation queues
 * are not an organizer's business even when the same person holds both roles.
 */
export type MessageAudience = 'CUSTOMER' | 'ORGANIZER' | 'ADMIN';

export const MESSAGE_AUDIENCE: Record<NotificationType, MessageAudience> = {
  // ── The person who bought, holds, or was given a ticket ─────────────────────────
  [NotificationType.BOOKING_CONFIRMED]: 'CUSTOMER',
  [NotificationType.PAYMENT_FAILED]: 'CUSTOMER',
  [NotificationType.BOOKING_CANCELLED]: 'CUSTOMER',
  [NotificationType.REFUND_COMPLETED]: 'CUSTOMER',
  [NotificationType.EVENT_REMINDER]: 'CUSTOMER',
  [NotificationType.TICKET_CHECKED_IN]: 'CUSTOMER',
  [NotificationType.TICKET_TRANSFERRED]: 'CUSTOMER',
  [NotificationType.ATTENDEE_INVITED]: 'CUSTOMER',
  [NotificationType.ATTENDEE_ACCEPTED]: 'CUSTOMER',
  [NotificationType.ATTENDEE_DECLINED]: 'CUSTOMER',
  [NotificationType.SHARE_CREATED]: 'CUSTOMER',
  [NotificationType.SHARE_VIEWED]: 'CUSTOMER',
  [NotificationType.SHARE_REVOKED]: 'CUSTOMER',

  // ── Somebody running events: their money, their applications ────────────────────
  [NotificationType.PAYOUT_ACCOUNT_UPDATED]: 'ORGANIZER',
  [NotificationType.SETTLEMENT_RELEASED]: 'ORGANIZER',
  [NotificationType.PAYMENT_DISPUTE_OPENED]: 'ORGANIZER',
  [NotificationType.PAYMENT_DISPUTE_CLOSED]: 'ORGANIZER',
  [NotificationType.TRANSFER_FAILED]: 'ORGANIZER',
  [NotificationType.ORGANIZATION_APPROVED]: 'ORGANIZER',
  [NotificationType.ORGANIZATION_REJECTED]: 'ORGANIZER',
  [NotificationType.EVENT_APPROVED]: 'ORGANIZER',
  [NotificationType.EVENT_REJECTED]: 'ORGANIZER',

  // ── The platform's own moderation queue ─────────────────────────────────────────
  [NotificationType.ORGANIZATION_REGISTERED]: 'ADMIN',
  [NotificationType.EVENT_SUBMITTED]: 'ADMIN',
};

/**
 * Falls back to CUSTOMER for an unclassified type.
 *
 * The opposite of the MessageClass default, and for the same reason: the risk here is
 * HIDING something from the person it concerns, not over-sending. A message that turns up in
 * the wrong inbox is noticed and reported — this very report. One that turns up in no inbox
 * is not.
 */
export function audienceOf(type: NotificationType): MessageAudience {
  return MESSAGE_AUDIENCE[type] ?? 'CUSTOMER';
}

/** The notification types belonging to one audience, for an inbox query. */
export function typesForAudience(audience: MessageAudience): NotificationType[] {
  return (Object.keys(MESSAGE_AUDIENCE) as NotificationType[]).filter(
    (t) => MESSAGE_AUDIENCE[t] === audience,
  );
}
