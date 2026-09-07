import { NotificationType } from '@eticketsgo/shared-types';
import type { ChannelKey } from '../channels/notification-channel.interface';

/**
 * What the platform is allowed to do about each kind of message.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────────────
 * Phase 1's `CHANNEL_POLICY` answered one question — which channels may this type use —
 * and answered it well. Three more questions turned out to sit next to it, and they were
 * being answered implicitly or not at all:
 *
 *   Which channels may a customer NOT turn off? Every channel was individually disableable,
 *   so somebody could quietly configure themselves into a state where a cancelled show
 *   reached them nowhere.
 *
 *   When may one channel's silence justify paying for another? Nothing expressed that, so
 *   the only options were "never" or an uncontrolled "WhatsApp failed, send an SMS" that
 *   duplicates messages and bills for the privilege.
 *
 *   Does a channel need an affirmative opt-in even for a transactional message? WhatsApp
 *   does, in some readings and some markets, and there was nowhere to say so.
 *
 * All four are properties of the EVENT, so they live together, declared, in one table.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────
 * Any provider. Nothing in this file knows that India uses MSG91 or that email is SES.
 * Policy decides WHICH CHANNELS; `NotificationProviderResolver` decides who carries them,
 * per message, from the destination. Merging the two would put a vendor name in a product
 * decision, and the resulting service would be the giant conditional both phases avoided.
 */

const E: ChannelKey = 'email';
const A: ChannelKey = 'in_app';
const P: ChannelKey = 'push';
const S: ChannelKey = 'sms';
const W: ChannelKey = 'whatsapp';

/** How much it matters that this arrives, which is what justifies spending money on it. */
export type Urgency = 'ROUTINE' | 'IMPORTANT' | 'URGENT';

/**
 * When one paid channel may be opened because the others produced nothing.
 *
 * ── WHY THIS IS NOT "WHATSAPP FAILED, SEND AN SMS" ─────────────────────────────────
 * Because that rule sends two messages every time WhatsApp is merely slow, and bills for
 * both. A fallback needs a deterministic trigger — a wait, and a definition of what counts
 * as the message having got through — or it is just a second send with extra steps.
 */
export interface FallbackPolicy {
  /** The channel opened as a last resort. */
  to: ChannelKey;
  /**
   * How long the preferred channels get first. Not a guess at network latency: it is how
   * long is acceptable for somebody not to know their show is off.
   */
  afterMinutes: number;
  /** The channels whose success makes the fallback unnecessary. */
  satisfiedBy: readonly ChannelKey[];
}

export interface EventPolicy {
  /** The channels this type may use at all. Absent from this list means never. */
  channels: readonly ChannelKey[];
  urgency: Urgency;
  /**
   * Channels a customer preference may NOT remove.
   *
   * ── WHY ANY CHANNEL IS UNDISABLEABLE ──────────────────────────────────────────────
   * Preferences exist so people can stop the messages they do not want. Applied without a
   * floor, they also let somebody switch off every channel a cancelled show could reach
   * them on — usually by unchecking things one at a time, months apart, with no moment
   * where the consequence is visible. They then travel to a venue with nothing on, and
   * every single opt-out was honoured exactly as they asked.
   *
   * So the floor is the inbox plus, for anything about a booking, email: the record of the
   * transaction goes to the address the transaction was made with.
   */
  guaranteed: readonly ChannelKey[];
  /** Explicit and event-specific. Absent means no fallback, which is most types. */
  fallback?: FallbackPolicy;
  /**
   * Channels needing an affirmative opt-in even when the message is transactional.
   *
   * Separate from marketing consent and never a substitute for it: this asks "may we use
   * this channel to reach you at all", which is a different question from "may we sell to
   * you". A missing opt-in removes THAT CHANNEL and never the notification.
   *
   * ── WHY IT IS DECLARED HERE AND ENFORCED IN CONFIGURATION ──────────────────────────
   * That WhatsApp business messaging rests on the recipient having agreed to be reached
   * there is a fact about the channel, and belongs with the channel. Whether the platform
   * requires that agreement before using it is a product and legal decision per market, and
   * belongs to whoever is accountable for that market -- so it is declared here and switched
   * on by `WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED`, which is OFF by default. Enforcing it
   * before the opt-in has been collected would stop every existing customer's WhatsApp
   * overnight, because absence of a consent record correctly means no.
   */
  optInRequired?: readonly ChannelKey[];
}

/**
 * The table. Types absent from it fall back to {@link FALLBACK_POLICY}: email, the inbox and
 * push — what every notification did before any of this existed, and never a paid channel.
 */
export const EVENT_POLICY: Partial<Record<NotificationType, EventPolicy>> = {
  /*
    A confirmed booking is the ticket. WhatsApp is how an Indian buyer expects to receive it;
    push reaches the app where the ticket lives. No SMS: the message is long, carries a link,
    and the same information arrives free on three other channels.
  */
  [NotificationType.BOOKING_CONFIRMED]: {
    channels: [E, A, P, W],
    urgency: 'IMPORTANT',
    guaranteed: [E, A],
    optInRequired: [W],
  },

  /*
    A cancelled booking is what a customer sees when a show is called off, and it is the only
    message on the platform worth paying for on every channel.

    ── WHY SMS IS A FALLBACK AND NOT AN IMMEDIATE CHANNEL ─────────────────────────────
    Sending it alongside the other three would mean everybody with a phone gets four
    messages about one cancellation, and we pay for the one they were least likely to need.
    Sending it only when nothing else worked costs almost nothing and reaches the person who
    has no app, no data and no email set up — which is exactly who the SMS is for.

    Thirty minutes is not a guess at network latency. It is how long is acceptable for
    somebody not to know their show is off, and it is long enough that a WhatsApp delivery
    receipt has plainly arrived or plainly is not going to.
  */
  [NotificationType.BOOKING_CANCELLED]: {
    channels: [E, A, P, W, S],
    urgency: 'URGENT',
    guaranteed: [E, A],
    fallback: { to: S, afterMinutes: 30, satisfiedBy: [W, P, E] },
    optInRequired: [W],
  },

  /* Money owed back. Email is the record; WhatsApp is where people ask "did it come through". */
  [NotificationType.REFUND_COMPLETED]: {
    channels: [E, A, P, W],
    urgency: 'IMPORTANT',
    guaranteed: [E, A],
    optInRequired: [W],
  },

  /*
    A show that moved. The customer still holds a ticket and now has to act on new
    information. No SMS: that is reserved for a cancellation, where somebody might otherwise
    travel to a dark venue.
  */
  [NotificationType.SHOW_CHANGED]: {
    channels: [E, A, P, W],
    urgency: 'URGENT',
    guaranteed: [E, A],
    optInRequired: [W],
  },

  /* A failure the customer must act on — email for the detail, push to catch them now. */
  [NotificationType.PAYMENT_FAILED]: {
    channels: [E, A, P],
    urgency: 'IMPORTANT',
    guaranteed: [E, A],
  },

  /*
    A reminder is a courtesy, not a record, so no email — an inbox full of "your show is
    tomorrow" is how people learn to ignore a sender. Nothing is guaranteed beyond the inbox:
    this is the one type somebody should be able to turn off completely.
  */
  [NotificationType.EVENT_REMINDER]: {
    channels: [A, P, W],
    urgency: 'ROUTINE',
    guaranteed: [A],
    optInRequired: [W],
  },

  /* Organizer money. Their console and their email; not their WhatsApp, not at 3am. */
  [NotificationType.SETTLEMENT_RELEASED]: {
    channels: [E, A],
    urgency: 'IMPORTANT',
    guaranteed: [E, A],
  },
};

/** Email + inbox + push, and never a paid channel. What an unlisted type gets. */
export const FALLBACK_POLICY: EventPolicy = {
  channels: [E, A, P],
  urgency: 'ROUTINE',
  guaranteed: [A],
};

/** The policy for a type, with the inbox always present so the notification centre holds. */
export function policyFor(type: NotificationType): EventPolicy {
  const declared = EVENT_POLICY[type] ?? FALLBACK_POLICY;
  return declared.channels.includes('in_app')
    ? declared
    : { ...declared, channels: [...declared.channels, 'in_app'] };
}

/**
 * The channels sent IMMEDIATELY, which is everything except a fallback target.
 *
 * A fallback channel is in `channels` because policy has to permit it before anything may
 * use it — but permitting is not scheduling. Sending it up front would produce exactly the
 * duplicate-and-bill behaviour the fallback exists to avoid.
 */
export function immediateChannels(type: NotificationType): ChannelKey[] {
  const policy = policyFor(type);
  const deferred = policy.fallback?.to;
  return policy.channels.filter((c) => c !== deferred);
}

// ─── Compatibility with the Phase 1 helpers, which are used widely ───

/** Every channel a type may EVER use, fallback target included. */
export function channelsFor(type: NotificationType): ChannelKey[] {
  return [...policyFor(type).channels];
}

/**
 * Narrow an explicit caller request down to what policy permits immediately.
 *
 * A caller naming channels is expressing a real intent — the settlement service asks for
 * `['in_app','email']` because a payout notice has no business on a customer's push feed —
 * so its list is honoured, minus anything policy does not allow. A caller can always ask for
 * LESS than policy, never more.
 */
export function permittedChannels(type: NotificationType, requested?: string[]): ChannelKey[] {
  const allowed = immediateChannels(type);
  if (!requested) return allowed;
  return allowed.filter((c) => requested.includes(c));
}

/**
 * The messages whose absence is a customer-facing failure, not an inconvenience.
 *
 * These are written in the SAME transaction as the domain change they describe (ADR-045
 * addendum). `NotificationService.sendCritical` takes the transaction client as its first
 * required argument so a producer cannot omit it.
 */
export const CRITICAL_TYPES: readonly NotificationType[] = [
  NotificationType.BOOKING_CONFIRMED,
  NotificationType.BOOKING_CANCELLED,
  NotificationType.REFUND_COMPLETED,
  NotificationType.SETTLEMENT_RELEASED,
  NotificationType.SHOW_CHANGED,
];

export function isCritical(type: NotificationType): boolean {
  return CRITICAL_TYPES.includes(type);
}

/** Kept for the Phase 1 tests that assert the raw table; `policyFor` is the way in. */
export const CHANNEL_POLICY: Partial<Record<NotificationType, readonly ChannelKey[]>> =
  Object.fromEntries(
    Object.entries(EVENT_POLICY).map(([type, policy]) => [type, policy!.channels]),
  );

export const FALLBACK_CHANNELS: readonly ChannelKey[] = FALLBACK_POLICY.channels;
