import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import type { ChannelKey } from '../channels/notification-channel.interface';
import { MarketingConsentService } from '../marketing-consent.service';
import { NotificationPreferencesService } from '../notification-preferences.service';
import { isTransactional, messageClassOf } from '../message-class';
import {
  policyFor,
  permittedChannels,
  type EventPolicy,
  type FallbackPolicy,
  type Urgency,
} from './notification-policy';

/**
 * The consent scope for using WhatsApp to carry a message about somebody's booking.
 *
 * ── WHY IT IS A SCOPE ON THE EXISTING TABLE AND NOT A NEW ONE ──────────────────────
 * `MarketingConsent` already records exactly what a WhatsApp opt-in needs: a subject, a
 * channel, granted or withdrawn, when, how it was obtained, and an append-only history that
 * makes a withdrawal a new row rather than an edit. That is the whole shape. Adding a second
 * table because the word "marketing" is in the model name would give the platform two places
 * to look for one person's answer, two APIs to keep in step, and two things to produce for a
 * data-subject request.
 *
 * What it does need is separation of MEANING. `whatsapp` on that table means "you may sell to
 * me on WhatsApp"; this scope means "you may use WhatsApp to tell me about my booking". They
 * are different questions and answering one with the other is the conflation the brief warns
 * about — somebody who opts out of offers has not asked to stop receiving their tickets.
 */
export const WHATSAPP_TRANSACTIONAL_SCOPE = 'whatsapp:transactional';

export interface PolicyRecipient {
  userId?: string | null;
  email?: string | null;
}

export interface ResolvedPolicy {
  /** The channels to send on now. Never includes a deferred fallback target. */
  channels: ChannelKey[];
  urgency: Urgency;
  fallback?: FallbackPolicy;
  transactional: boolean;
  /** Channels policy allowed that a preference, a consent or an opt-in removed. */
  removed: { channel: ChannelKey; reason: string }[];
}

/**
 * One place that answers "who gets told, on what".
 *
 * ── THE SEPARATION THIS EXISTS TO HOLD ─────────────────────────────────────────────
 *
 *   domain event → POLICY → channel → provider resolver → provider adapter
 *
 * Everything left of the arrow into `provider resolver` is product: which kinds of message
 * may use which channels, what a customer asked for, what they consented to. Everything right
 * of it is vendor: who carries an Indian SMS. Nothing in this file knows a provider's name,
 * and nothing in the provider resolver knows what a booking confirmation is.
 *
 * Keeping them apart is why adding MSG91 in Phase 1 required no product decision, and why
 * changing the channels for a show cancellation requires no vendor knowledge.
 *
 * ── THE THREE QUESTIONS, KEPT DISTINCT ─────────────────────────────────────────────
 *   Consent     may we send this CATEGORY of communication? (marketing, WhatsApp opt-in)
 *   Preference  which optional channel does this person want?
 *   Suppression can this destination physically receive anything? (Phase 2, checked at send)
 *
 * Collapsing any two of them breaks the platform in a way nobody notices for months.
 */
@Injectable()
export class NotificationPolicyResolver {
  private readonly logger = new Logger('Notification');

  constructor(
    private readonly preferences: NotificationPreferencesService,
    private readonly consent: MarketingConsentService,
    private readonly config?: ConfigService,
  ) {}

  /**
   * Resolve the channels for one message.
   *
   * `known` is the set of channels the registry can actually deliver on, passed in rather
   * than looked up so this stays a pure product decision with no delivery machinery in it.
   */
  async resolve(input: {
    type: NotificationType;
    recipient: PolicyRecipient;
    /** A caller may ask for FEWER channels than policy permits. Never more. */
    requested?: string[];
    /** Channels the registry can deliver on. */
    known: (channel: string) => boolean;
    /** Only the fallback service sets this. See NotifyInput.allowDeferredChannel. */
    allowDeferred?: boolean;
  }): Promise<ResolvedPolicy> {
    const policy: EventPolicy = policyFor(input.type);
    const transactional = isTransactional(input.type);
    const removed: { channel: ChannelKey; reason: string }[] = [];

    /*
      1. What policy permits, narrowed by anything the caller asked for.

      `permittedChannels` withholds the fallback target: policy allows it, but sending it up
      front is what turns a fallback into a duplicate. The fallback service, and only the
      fallback service, asks for the full list once its wait has elapsed.
    */
    const allowed = input.allowDeferred
      ? policy.channels.filter((c) => !input.requested || input.requested.includes(c))
      : permittedChannels(input.type, input.requested);
    let channels = allowed.filter((c) => input.known(c));

    // 2. What the customer turned off — except what they may not turn off.
    channels = await this.applyPreferences(input, policy, channels, removed);

    // 3. Consent. Two different questions, in the right order.
    channels = await this.applyConsent(input, policy, channels, transactional, removed);

    if (removed.length > 0) {
      this.logger.log(
        `${messageClassOf(input.type)} ${input.type}: ${removed
          .map((r) => `${r.channel}(${r.reason})`)
          .join(', ')}`,
      );
    }

    return { channels, urgency: policy.urgency, fallback: policy.fallback, transactional, removed };
  }

  /**
   * Honour what the customer asked for, down to a floor.
   *
   * ── WHY THERE IS A FLOOR ───────────────────────────────────────────────────────────
   * Preferences exist so people can stop messages they do not want, and almost every type
   * should be switchable off entirely. But applied without a floor they also let somebody
   * disable every channel a cancelled show could reach them on — one unchecked box at a
   * time, months apart, with no moment where the consequence is visible. They then travel to
   * a venue with nothing on, and every opt-out was honoured exactly as asked.
   *
   * So a guaranteed channel stays. It is logged when it happens, because a person who has
   * asked twice and is still receiving email deserves a better answer than silence — but a
   * missing cancellation notice is the worse failure of the two.
   */
  private async applyPreferences(
    input: { type: NotificationType; recipient: PolicyRecipient },
    policy: EventPolicy,
    channels: ChannelKey[],
    removed: { channel: ChannelKey; reason: string }[],
  ): Promise<ChannelKey[]> {
    const userId = input.recipient.userId ?? null;
    if (!userId) return channels;

    const enabled = await this.preferences.resolveChannels(userId, input.type, channels);
    const kept: ChannelKey[] = [];
    for (const channel of channels) {
      if (enabled.includes(channel)) {
        kept.push(channel);
        continue;
      }
      if (policy.guaranteed.includes(channel)) {
        this.logger.warn(
          `${input.type}: ${channel} is disabled by preference but guaranteed by policy; keeping it`,
        );
        kept.push(channel);
        continue;
      }
      removed.push({ channel, reason: 'preference' });
    }
    return kept;
  }

  private async applyConsent(
    input: { type: NotificationType; recipient: PolicyRecipient },
    policy: EventPolicy,
    channels: ChannelKey[],
    transactional: boolean,
    removed: { channel: ChannelKey; reason: string }[],
  ): Promise<ChannelKey[]> {
    const subject = { userId: input.recipient.userId, email: input.recipient.email };

    /*
      A commercial message needs an affirmative record per channel, and the absence of one
      means NO. Read the other way, the first promotional message ever added would go to
      everybody who ever bought a ticket.
    */
    if (!transactional) {
      const allowed: ChannelKey[] = [];
      for (const channel of channels) {
        if (await this.consent.mayReceiveMarketing(subject, channel)) allowed.push(channel);
        else removed.push({ channel, reason: 'no marketing consent' });
      }
      return allowed;
    }

    /*
      A transactional message goes out on every channel the person left enabled. Withholding
      a ticket, a refund confirmation or a cancellation because of a MARKETING preference
      would be a product failure dressed up as a legal precaution.

      The one exception is a channel that needs permission to be used AT ALL, which is a
      different question from whether we may advertise on it. WhatsApp is the case: business
      messaging rests on the recipient having agreed to be reached there. Whether that
      agreement is required is a product and legal decision per market, not something to
      hardcode — so it is configuration, it defaults OFF (today's behaviour), and when it is
      on it removes THAT CHANNEL and never the notification. Email and push are untouched.
    */
    if (!policy.optInRequired || !this.optInEnforced()) return channels;

    const allowed: ChannelKey[] = [];
    for (const channel of channels) {
      if (!policy.optInRequired.includes(channel)) {
        allowed.push(channel);
        continue;
      }
      const scope = channel === 'whatsapp' ? WHATSAPP_TRANSACTIONAL_SCOPE : channel;
      if (await this.consent.mayReceiveMarketing(subject, scope)) allowed.push(channel);
      else removed.push({ channel, reason: 'no channel opt-in' });
    }
    return allowed;
  }

  /**
   * Whether a transactional opt-in is enforced for the channels that declare one.
   *
   * Off by default, deliberately. Turning it on without the opt-in having been COLLECTED
   * would stop every existing customer's WhatsApp overnight, because absence of a record
   * means no — which is the right default for a consent question and the wrong thing to
   * apply retroactively to people who were never asked.
   */
  private optInEnforced(): boolean {
    return this.config?.get<string>('WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED') === 'true';
  }
}
