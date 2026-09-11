import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  capabilityFor,
  parseEnabledMarkets,
  requiresTemplateBinding,
  type NotificationChannelKey,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { TemplateBindingService } from '../templates/template-binding.service';
import { fallbackChannelFor, immediateChannels } from '../policy/notification-policy';
import { NotificationType } from '@eticketsgo/shared-types';

/**
 * One row per market, channel and provider, saying what is true about each.
 *
 * ── WHY A SEPARATE REPORT FROM READINESS AND CERTIFICATION ─────────────────────────
 * The three answer questions that are genuinely different, and merging them produced a single
 * verdict that hid whichever half was inconvenient.
 *
 *   Readiness answers "is a variable set", per market.
 *   Certification answers "has a message demonstrably arrived", from delivery evidence.
 *   This answers "what, precisely, is the state of each moving part" — credentials, templates,
 *   callbacks, rates and certification, side by side and separately.
 *
 * The last one is what an operator needs while SETTING UP. "India WhatsApp: credentials READY,
 * templates BLOCKED_TEMPLATE_APPROVAL, webhook NOT_OBSERVED, rate MISSING" is four next
 * actions. "India: PARTIAL" is a shrug.
 *
 * ── WHY NO SECRET APPEARS, EVER ────────────────────────────────────────────────────
 * This is the report somebody screenshots into a launch thread. It names KEYS and never
 * reads a value into the response — a test asserts that, because the discipline is only worth
 * anything if it cannot quietly lapse.
 */

export type ConfigState = 'READY' | 'MISSING' | 'PARTIAL' | 'DISABLED';
export type TemplateState =
  'READY' | 'NOT_REQUIRED' | 'PARTIAL' | 'BLOCKED_TEMPLATE_APPROVAL' | 'BLOCKED_DLT';
/**
 * Webhook health is a fact about the PROVIDER's dashboard, which nothing here can see.
 *
 * `NOT_OBSERVED` is the honest resting state and it is not a fault: it means no callback has
 * ever arrived, which is exactly what is true before anybody has sent anything. It is never
 * promoted to READY by configuration — only by a real callback landing in a delivery row.
 */
export type WebhookState = 'OBSERVED' | 'NOT_OBSERVED' | 'NOT_SUPPORTED' | 'MISSING_SECRET';
export type RateState = 'CONFIGURED' | 'CONFIGURED_FREE' | 'MISSING';
export type ExternalCertificationState =
  'LIVE_CERTIFIED' | 'CONTRACT_TESTED' | 'BLOCKED_EXTERNAL_CERTIFICATION' | 'NOT_CERTIFIED';

export interface DiagnosticRow {
  market: string;
  channel: NotificationChannelKey;
  enabled: boolean;
  provider: string | null;
  configState: ConfigState;
  templateState: TemplateState;
  webhookState: WebhookState;
  rateState: RateState;
  externalCertificationState: ExternalCertificationState;
  /** Keys that are unset. Names only — never a value. */
  missingKeys: string[];
  /** Notification types with no provider template bound. Never the template ids themselves. */
  unboundTypes: string[];
}

@Injectable()
export class NotificationDiagnosticsService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly bindings: TemplateBindingService,
  ) {}

  private set(key: string): boolean {
    const v = this.config.get<string>(key);
    return typeof v === 'string' && v.trim().length > 0;
  }

  async report() {
    const enabled = parseEnabledMarkets(this.config.get<string>('NOTIFICATION_MARKETS'));
    /*
      Every market this deployment could conceivably touch, not only the enabled ones. A
      market that is routed but not enabled is a contradiction the operator needs to SEE
      rather than have quietly filtered out of the report that would have shown it.
    */
    const routed = new Set([...enabled, ...this.routedMarkets()]);
    const rows: DiagnosticRow[] = [];
    for (const market of [...routed].sort()) {
      for (const channel of ['email', 'sms', 'whatsapp', 'push'] as NotificationChannelKey[]) {
        rows.push(await this.row(market, channel, enabled.includes(market)));
      }
    }
    return {
      enabledMarkets: enabled,
      rows,
      /*
        The one-line summary, computed from the enabled markets only. A disabled market is
        not a blocker; counting it as one is what made the previous report unreadable.
      */
      blockers: rows.filter(
        (r) =>
          r.enabled &&
          (r.configState === 'MISSING' ||
            r.configState === 'PARTIAL' ||
            r.templateState === 'BLOCKED_DLT' ||
            r.templateState === 'BLOCKED_TEMPLATE_APPROVAL'),
      ).length,
    };
  }

  private routedMarkets(): string[] {
    const out: string[] = [];
    for (const key of ['SMS_PROVIDER_BY_MARKET', 'WHATSAPP_PROVIDER_BY_MARKET']) {
      for (const entry of (this.config.get<string>(key) ?? '').split(',')) {
        const [m] = entry.split('=');
        if (m?.trim()) out.push(m.trim().toUpperCase());
      }
    }
    return out;
  }

  private providerFor(channel: NotificationChannelKey, market: string): string | null {
    if (channel === 'email') return this.config.get<string>('EMAIL_PROVIDER') ?? 'log';
    if (channel === 'push') return this.config.get<string>('PUSH_PROVIDER') ?? 'log';
    const key = channel === 'sms' ? 'SMS_PROVIDER_BY_MARKET' : 'WHATSAPP_PROVIDER_BY_MARKET';
    for (const entry of (this.config.get<string>(key) ?? '').split(',')) {
      const [m, p] = entry.split('=');
      if (m?.trim().toUpperCase() === market && p?.trim()) return p.trim().toLowerCase();
    }
    return (
      this.config.get<string>(channel === 'sms' ? 'SMS_PROVIDER' : 'WHATSAPP_PROVIDER') ?? 'log'
    );
  }

  private credentialsFor(provider: string, channel: NotificationChannelKey): string[] {
    switch (`${provider}:${channel}`) {
      case 'ses:email':
        return ['AWS_REGION', 'EMAIL_FROM', 'SES_CONFIGURATION_SET', 'SES_WEBHOOK_SECRET'];
      case 'sendgrid:email':
        return ['SENDGRID_API_KEY', 'EMAIL_FROM'];
      case 'twilio:sms':
        return [
          'TWILIO_ACCOUNT_SID',
          'TWILIO_AUTH_TOKEN',
          // Sends go through the Messaging Service, whose callback URL is what reports delivery.
          'TWILIO_MESSAGING_SERVICE_SID',
          // Twilio signs the callback URL, so this is a credential in everything but name:
          // wrong, and every callback fails verification indistinguishably from an attack.
          'PUBLIC_API_URL',
        ];
      case 'msg91:sms':
        return ['MSG91_AUTH_KEY', 'MSG91_SENDER_ID', 'MSG91_WEBHOOK_SECRET'];
      case 'msg91:whatsapp':
        return ['MSG91_AUTH_KEY', 'MSG91_WHATSAPP_NUMBER', 'MSG91_WEBHOOK_SECRET'];
      case 'cloud:whatsapp':
        return [
          'WHATSAPP_PHONE_NUMBER_ID',
          'WHATSAPP_ACCESS_TOKEN',
          'WHATSAPP_APP_SECRET',
          'WHATSAPP_VERIFY_TOKEN',
        ];
      case 'fcm:push':
        return ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY'];
      // Expo needs no credential: the device token authorises delivery to that installation.
      case 'expo:push':
        return [];
      default:
        return [];
    }
  }

  private async row(
    market: string,
    channel: NotificationChannelKey,
    enabled: boolean,
  ): Promise<DiagnosticRow> {
    const provider = this.providerFor(channel, market);
    const base: DiagnosticRow = {
      market,
      channel,
      enabled,
      provider,
      configState: 'DISABLED',
      templateState: 'NOT_REQUIRED',
      webhookState: 'NOT_SUPPORTED',
      rateState: 'MISSING',
      externalCertificationState: 'NOT_CERTIFIED',
      missingKeys: [],
      unboundTypes: [],
    };
    if (!provider || provider === 'log') return base;

    const keys = this.credentialsFor(provider, channel);
    const missing = keys.filter((k) => !this.set(k));
    base.missingKeys = missing;
    base.configState =
      keys.length === 0 || missing.length === 0
        ? 'READY'
        : missing.length === keys.length
          ? 'MISSING'
          : 'PARTIAL';

    // ── templates ──
    if (requiresTemplateBinding(provider, channel)) {
      const unbound = this.unboundTypes(provider, channel);
      base.unboundTypes = unbound;
      if (unbound.length === 0) {
        base.templateState = 'READY';
      } else if (channel === 'sms' && market === 'IN') {
        /*
          India SMS is blocked on a telecom registration, not on somebody remembering to
          paste an id. Said differently from an ordinary missing template so a launch review
          can tell a five-minute task from a multi-day dependency.
        */
        base.templateState = 'BLOCKED_DLT';
      } else {
        base.templateState = 'BLOCKED_TEMPLATE_APPROVAL';
      }
    }

    // ── webhooks: observed, or not. Never inferred from a secret being present. ──
    const capability = capabilityFor(provider, channel);
    if (!capability?.supportsDeliveryReceipt) {
      base.webhookState = 'NOT_SUPPORTED';
    } else {
      const secretKey =
        capability.webhookAuth === 'endpoint_secret'
          ? 'MSG91_WEBHOOK_SECRET'
          : provider === 'ses'
            ? 'SES_WEBHOOK_SECRET'
            : provider === 'cloud'
              ? 'WHATSAPP_APP_SECRET'
              : 'PUBLIC_API_URL';
      if (!this.set(secretKey)) {
        base.webhookState = 'MISSING_SECRET';
      } else {
        /*
          A `providerStatus` can only have been written by a provider posting to us. It is
          the single fact in this whole report that configuration cannot fake.
        */
        const observed = await this.prisma.notificationDelivery.findFirst({
          where: { provider, channel, providerStatus: { not: null } },
          select: { id: true },
        });
        base.webhookState = observed ? 'OBSERVED' : 'NOT_OBSERVED';
      }
    }

    // ── rate ──
    const now = new Date();
    const rate = await this.prisma.notificationRate.findFirst({
      where: {
        active: true,
        provider,
        channel,
        country: { in: [market, '*'] },
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { unitPriceMicro: true },
    });
    base.rateState = !rate
      ? 'MISSING'
      : rate.unitPriceMicro === 0
        ? // Explicitly free is a complete answer; an absent rate is not. Reporting them the
          // same way is what makes a cost total silently a floor.
          'CONFIGURED_FREE'
        : 'CONFIGURED';

    // ── certification, read from the evidence table ──
    const cert = await this.prisma.notificationCertification.findFirst({
      where: { provider, channel, market: { in: [market, '*'] } },
      select: { state: true },
    });
    base.externalCertificationState =
      cert?.state === 'LIVE_CERTIFIED'
        ? 'LIVE_CERTIFIED'
        : cert?.state === 'CONTRACT_TESTED'
          ? 'CONTRACT_TESTED'
          : base.configState === 'READY' && base.templateState !== 'READY'
            ? 'BLOCKED_EXTERNAL_CERTIFICATION'
            : 'NOT_CERTIFIED';
    return base;
  }

  /** Types this channel is asked to carry with no template bound. Driven by policy. */
  private unboundTypes(provider: string, channel: string): string[] {
    const types = Object.values(NotificationType).filter(
      (t) => immediateChannels(t).includes(channel as never) || fallbackChannelFor(t) === channel,
    );
    return types
      .filter((t) => !this.bindings.resolve({ provider, channel, type: t, locale: null }))
      .map((t) => String(t));
  }
}
