import { Injectable } from '@nestjs/common';
import { NotificationType, SendKind } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  NotificationReadinessService,
  type ComponentReadiness,
  type ReadinessState,
} from './notification-readiness.service';

/**
 * How far along one provider is, on a scale that does not let configuration masquerade as
 * proof.
 *
 * ── WHY FOUR STATES AND NOT A BOOLEAN ──────────────────────────────────────────────
 * Because "ready" is four different claims and only the last one is worth anything on a
 * launch call. The whole point of the ladder is that the first three are things this
 * repository can establish about itself, and the fourth is a thing only a real provider can
 * establish about us.
 *
 *   CODE_READY                     the adapter, routing, callbacks and tests exist
 *   CONFIG_READY                   credentials, templates and rates are present
 *   EXTERNAL_VERIFICATION_REQUIRED configured, but nothing has ever been sent
 *   LIVE_CERTIFIED                 a real send was accepted and a real callback came back
 *
 * A boolean would collapse those, and it always collapses them upward: the day somebody sets
 * an environment variable, a dashboard turns green and a launch decision gets made on the
 * strength of a string being non-empty.
 */
export type CertificationLevel =
  'CODE_READY' | 'CONFIG_READY' | 'EXTERNAL_VERIFICATION_REQUIRED' | 'LIVE_CERTIFIED';

/** The verdict for one channel in one market. */
export type CertificationOutcome =
  'PASS' | 'FAIL' | 'BLOCKED_EXTERNAL_SETUP' | 'NOT_CONFIGURED' | 'NOT_APPLICABLE';

export interface ChannelCertification {
  channel: string;
  provider: string | null;
  level: CertificationLevel;
  outcome: CertificationOutcome;
  /** Safe detail. Names keys and actions, never a value. */
  detail?: string;
  /** What a human must do in a provider console before this can advance. */
  action?: string;
  evidence?: {
    lastTestSendAt: Date | null;
    lastProviderAcceptedAt: Date | null;
    lastCallbackAt: Date | null;
    ratesConfigured: boolean;
  };
}

export interface MarketCertification {
  market: string;
  level: CertificationLevel;
  channels: ChannelCertification[];
}

/**
 * Whether a market can actually be launched, judged on evidence rather than on configuration.
 *
 * ── WHY THIS ASKS THE DATABASE AND NOT THE ENVIRONMENT ─────────────────────────────
 * `NotificationReadinessService` answers "is it configured", which is a question about
 * environment variables. This answers "has it ever worked", which is a question about
 * `NotificationDelivery` rows: did a real message reach this provider, did the provider
 * accept it, did a callback come back.
 *
 * Those are different claims and the second cannot be inferred from the first. A perfectly
 * configured MSG91 account with an unapproved DLT template is `CONFIG_READY` and will carry
 * nothing — the request is accepted, the carrier drops it, and the first evidence is a
 * customer saying their ticket never arrived. Only a send and a delivery report distinguish
 * the two, which is why nothing here reports PASS on the strength of a variable being set.
 *
 * ── WHY IT SENDS NOTHING ITSELF ────────────────────────────────────────────────────
 * A certification routine that proves a provider by sending through it bills for every run
 * and, on WhatsApp, messages a real number. The operator test-send is the deliberate,
 * privileged, audited action; this reads what those sends left behind.
 */
@Injectable()
export class MarketCertificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: NotificationReadinessService,
  ) {}

  /**
   * Evidence that a provider has actually carried something on a channel.
   *
   * Only TEST traffic counts as certification evidence for the send, because that is what an
   * operator deliberately did to prove it. A customer message that happened to succeed is
   * excellent news and is not a certification: nobody chose it, and nobody was watching.
   */
  private async evidenceFor(provider: string, channel: string) {
    const [lastTest, lastAccepted, lastCallback, rates] = await Promise.all([
      this.prisma.notificationDelivery.findFirst({
        where: { provider, channel, sendKind: SendKind.TEST },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.notificationDelivery.findFirst({
        where: { provider, channel, acceptedAt: { not: null } },
        orderBy: { acceptedAt: 'desc' },
        select: { acceptedAt: true },
      }),
      /*
        A callback is the only thing that proves the RETURN path — the webhook URL is
        registered, the signature verifies, the correlation works. `providerStatus` is set
        only when a provider told us something, so its presence is the evidence.
      */
      this.prisma.notificationDelivery.findFirst({
        where: { provider, channel, providerStatus: { not: null } },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
      this.prisma.notificationRate.count({ where: { active: true, provider, channel } }),
    ]);

    return {
      lastTestSendAt: lastTest?.createdAt ?? null,
      lastProviderAcceptedAt: lastAccepted?.acceptedAt ?? null,
      lastCallbackAt: lastCallback?.updatedAt ?? null,
      ratesConfigured: rates > 0,
    };
  }

  /** Whether this channel can report delivery at all. Push cannot, and never will. */
  private hasReturnPath(channel: string): boolean {
    return channel !== 'push' && channel !== 'in_app';
  }

  async forMarket(market: string): Promise<MarketCertification> {
    const config = await this.readiness.forMarket(market);
    const channels: ChannelCertification[] = [];

    for (const component of config.components) {
      // Not a channel — the callback-configuration row is reported by the readiness endpoint.
      if (!['email', 'sms', 'whatsapp', 'push'].includes(component.key)) continue;

      const provider = this.providerName(component);
      channels.push(await this.certify(market, component.key, provider, component));
    }

    /*
      A market is only as certified as its weakest channel. Reporting the best one would
      produce exactly the launch call this whole ladder exists to prevent — "email is live" is
      not "India is live" when every Indian buyer expects WhatsApp.
    */
    const order: CertificationLevel[] = [
      'CODE_READY',
      'CONFIG_READY',
      'EXTERNAL_VERIFICATION_REQUIRED',
      'LIVE_CERTIFIED',
    ];
    const level = channels.reduce<CertificationLevel>(
      (worst, c) => (order.indexOf(c.level) < order.indexOf(worst) ? c.level : worst),
      'LIVE_CERTIFIED',
    );

    return { market, level, channels };
  }

  /**
   * The provider named in a readiness label like `SMS (msg91)`.
   *
   * Lower-cased, because the label is written for a human -- "Push (Expo)" -- and the
   * delivery rows are keyed on the provider identifier, `expo`. Comparing them as written
   * finds no evidence and reports a working provider as never used.
   */
  private providerName(component: { label: string }): string | null {
    const m = /\(([^)]+)\)/.exec(component.label);
    return m ? m[1].toLowerCase() : null;
  }

  private async certify(
    market: string,
    channel: string,
    provider: string | null,
    component: ComponentReadiness,
  ): Promise<ChannelCertification> {
    const configState: ReadinessState = component.state;
    const configDetail = component.detail;
    if (configState === 'DISABLED') {
      return {
        channel,
        provider,
        level: 'CODE_READY',
        outcome: 'NOT_APPLICABLE',
        detail: configDetail ?? `No provider routed for ${market}.`,
      };
    }
    if (configState === 'MISSING' || !provider) {
      return {
        channel,
        provider,
        level: 'CODE_READY',
        outcome: 'NOT_CONFIGURED',
        detail: configDetail,
        action: `Set the credentials named above, then re-run certification.`,
      };
    }

    const evidence = await this.evidenceFor(provider, channel);

    /*
      PARTIAL covers two different problems and only one of them stops a send.

      A missing credential or an unapproved template means nothing can go out at all, which is
      a configuration failure and stays at CODE_READY. A missing RATE means everything sends
      perfectly and nothing can be costed — the provider is working, so the send evidence
      below is meaningful and the rate is handled as its own rung further down.

      Distinguished from the structure rather than from the prose: text-matching a detail
      string is the kind of coupling that breaks the day somebody improves the wording.
    */
    const blockedFromSending =
      (component.missingCredentials?.length ?? 0) > 0 ||
      (component.missingExternal?.length ?? 0) > 0;
    if (configState === 'PARTIAL' && blockedFromSending) {
      return {
        channel,
        provider,
        level: 'CODE_READY',
        outcome: 'BLOCKED_EXTERNAL_SETUP',
        detail: configDetail,
        action: this.externalAction(provider, channel),
        evidence,
      };
    }

    // Able to send. Has anything actually gone through it?
    if (!evidence.lastProviderAcceptedAt) {
      return {
        channel,
        provider,
        level: 'CONFIG_READY',
        outcome: 'BLOCKED_EXTERNAL_SETUP',
        detail: 'Configured, but nothing has ever been sent through this provider.',
        action: `POST /admin/notifications/readiness/test-send with channel=${channel} and a destination you own.`,
        evidence,
      };
    }

    /*
      Accepted but never heard back from. For email, SMS and WhatsApp that means the RETURN
      path is unproven: the webhook may be unregistered, the signature may be failing, or the
      correlation may be broken — and every one of those looks identical from the send side,
      which is exactly why acceptance is not certification.
    */
    if (this.hasReturnPath(channel) && !evidence.lastCallbackAt) {
      return {
        channel,
        provider,
        level: 'EXTERNAL_VERIFICATION_REQUIRED',
        outcome: 'BLOCKED_EXTERNAL_SETUP',
        detail: 'Sends are accepted, but no delivery callback has ever been received.',
        action: this.callbackAction(provider, channel),
        evidence,
      };
    }

    if (!evidence.ratesConfigured) {
      /*
        Working and unpriced. Not a delivery failure, so not FAIL -- but every cost report is
        silently a floor until a rate exists, and calling that certified would put a number
        in front of somebody that is missing a component nobody mentioned.
      */
      return {
        channel,
        provider,
        level: 'EXTERNAL_VERIFICATION_REQUIRED',
        outcome: 'BLOCKED_EXTERNAL_SETUP',
        detail: 'Delivery is proven, but no rate is configured — cost reports as UNKNOWN.',
        action: `POST /admin/notifications/analytics/rates for ${provider}/${channel} in ${market}.`,
        evidence,
      };
    }

    return {
      channel,
      provider,
      level: 'LIVE_CERTIFIED',
      outcome: 'PASS',
      detail: this.hasReturnPath(channel)
        ? 'Accepted by the provider and confirmed by a callback.'
        : // Push has no delivery callback and never will; acceptance is the terminal
          // observable state, and saying so is more honest than an asterisk on a PASS.
          'Accepted by the provider. Push has no delivery receipt — acceptance is terminal.',
      evidence,
    };
  }

  /** The exact console action a human must take. Never a vague "configure the provider". */
  private externalAction(provider: string, channel: string): string {
    if (provider === 'msg91' && channel === 'sms') {
      return 'Register the DLT templates on the operator portal and set MSG91_SMS_TEMPLATE_IDS.';
    }
    if (provider === 'msg91' && channel === 'whatsapp') {
      return 'Register the WhatsApp business number with MSG91 and set MSG91_WHATSAPP_NUMBER and MSG91_WHATSAPP_TEMPLATES.';
    }
    if (provider === 'ses') {
      return 'Verify the sending domain, leave the SES sandbox, and configure a rate.';
    }
    return 'Complete the provider console setup named in the detail, then re-run certification.';
  }

  private callbackAction(provider: string, channel: string): string {
    switch (provider) {
      case 'ses':
        return 'Create an SES configuration set with an SNS event destination for Delivery/Bounce/Complaint/Reject, subscribe the endpoint, and confirm the subscription in the AWS console.';
      case 'twilio':
        return 'Set the Status Callback URL on the Twilio messaging service, and confirm PUBLIC_API_URL matches the public host Twilio calls.';
      case 'msg91':
        return `Register the MSG91 delivery-report URL (including MSG91_WEBHOOK_SECRET) for ${channel}.`;
      case 'cloud':
        return 'Subscribe the Meta app to the `messages` webhook field and confirm WHATSAPP_APP_SECRET matches the app secret.';
      default:
        return 'Register the provider delivery callback for this channel.';
    }
  }

  /** Every launch market, worst-first so the blocking one is impossible to miss. */
  async report(markets: string[] = ['IN', 'US', 'CA']) {
    const results = await Promise.all(markets.map((m) => this.forMarket(m)));
    return {
      markets: results,
      /*
        Deliberately not a boolean called `ok`. A launch decision needs to see WHICH rung
        every market is on, and a single flag invites reading the best number in the room.
      */
      lowestLevel: results.reduce<CertificationLevel>((worst, m) => {
        const order: CertificationLevel[] = [
          'CODE_READY',
          'CONFIG_READY',
          'EXTERNAL_VERIFICATION_REQUIRED',
          'LIVE_CERTIFIED',
        ];
        return order.indexOf(m.level) < order.indexOf(worst) ? m.level : worst;
      }, 'LIVE_CERTIFIED'),
      /** Everything a human still has to do in somebody else's console. */
      externalActions: results.flatMap((m) =>
        m.channels
          .filter((c) => c.action)
          .map((c) => ({
            market: m.market,
            channel: c.channel,
            provider: c.provider,
            outcome: c.outcome,
            action: c.action as string,
          })),
      ),
    };
  }

  /** Types whose policy selects WhatsApp, so an operator knows which templates to register. */
  static whatsAppTemplateTypes(): NotificationType[] {
    return [
      NotificationType.BOOKING_CONFIRMED,
      NotificationType.SHOW_CANCELLED,
      NotificationType.SHOW_CHANGED,
      NotificationType.REFUND_COMPLETED,
      NotificationType.EVENT_REMINDER,
    ];
  }
}
