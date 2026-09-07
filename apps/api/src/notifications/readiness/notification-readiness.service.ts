import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseMarketProviderMap } from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';

export type ReadinessState = 'CONFIGURED' | 'PARTIAL' | 'MISSING' | 'DISABLED';

export interface ComponentReadiness {
  key: string;
  label: string;
  state: ReadinessState;
  /** Never a secret. Names the KEY that is unset, never any part of its value. */
  detail?: string;
}

export interface MarketReadiness {
  market: string;
  ok: boolean;
  components: ComponentReadiness[];
}

/**
 * Whether this platform can actually send anything, per market.
 *
 * ── WHY IT REPORTS PRESENCE AND NEVER VALUE ────────────────────────────────────────
 * Every check below asks whether a key is SET. None of them read what it contains into a
 * response, a log or a detail string — a readiness endpoint is exactly the sort of thing that
 * ends up screenshotted into a chat, and "MSG91_AUTH_KEY is missing" is useful while
 * "MSG91_AUTH_KEY is abc123" is a leak.
 *
 * ── WHY IT SENDS NOTHING ───────────────────────────────────────────────────────────
 * A readiness check that proves a provider works by sending through it is a readiness check
 * that bills for every page load, and on WhatsApp it messages a real number. Configuration
 * presence is what can be established for free; the operator test-send is the separate,
 * privileged, audited action for the other half.
 *
 * ── WHY IT DOES NOT CLAIM WEBHOOKS ARE HEALTHY ─────────────────────────────────────
 * Whether Twilio is actually posting to our callback URL is a fact about Twilio's dashboard,
 * not about our configuration, and nothing here can observe it. The report says whether the
 * SECRET is configured — which is all we know — and the reader is told that is all it means.
 */
@Injectable()
export class NotificationReadinessService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private set(key: string): boolean {
    const v = this.config.get<string>(key);
    return typeof v === 'string' && v.trim().length > 0;
  }

  /** CONFIGURED when every key is set, MISSING when none are, PARTIAL in between. */
  private require(key: string, label: string, keys: string[]): ComponentReadiness {
    const missing = keys.filter((k) => !this.set(k));
    if (missing.length === 0) return { key, label, state: 'CONFIGURED' };
    if (missing.length === keys.length) {
      return { key, label, state: 'MISSING', detail: `Set ${keys.join(', ')}.` };
    }
    return { key, label, state: 'PARTIAL', detail: `Still missing: ${missing.join(', ')}.` };
  }

  /**
   * Whether a rate exists for a provider and channel, in force now.
   *
   * Configured-but-unpriced is `PARTIAL` rather than `CONFIGURED`, because a provider that
   * can send and cannot be costed produces reports whose totals are silently a floor.
   */
  private async rate(provider: string, channel: string, market: string): Promise<boolean> {
    const now = new Date();
    const found = await this.prisma.notificationRate.findFirst({
      where: {
        active: true,
        provider,
        channel,
        country: { in: [market, '*'] },
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { id: true },
    });
    return Boolean(found);
  }

  /** Which provider a market routes to for a channel, per the Phase 1 routing table. */
  private providerFor(channel: 'sms' | 'whatsapp', market: string): string | null {
    const key = channel === 'sms' ? 'SMS_PROVIDER_BY_MARKET' : 'WHATSAPP_PROVIDER_BY_MARKET';
    const map = parseMarketProviderMap(this.config.get<string>(key));
    if (Object.keys(map).length > 0) return map[market] ?? null;
    // No market table: the single-provider setting is the whole answer, which is what a
    // single-market or local deployment uses.
    const single = this.config.get<string>(
      channel === 'sms' ? 'SMS_PROVIDER' : 'WHATSAPP_PROVIDER',
    );
    return single ?? null;
  }

  private providerCredentials(provider: string): { label: string; keys: string[] } | null {
    switch (provider) {
      case 'twilio':
        return {
          label: 'Twilio SMS',
          keys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
        };
      case 'msg91':
        return { label: 'MSG91', keys: ['MSG91_AUTH_KEY'] };
      case 'cloud':
        return {
          label: 'Meta WhatsApp Cloud',
          keys: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'],
        };
      case 'log':
        return null;
      default:
        return null;
    }
  }

  /** One market's readiness across every channel it uses. */
  async forMarket(market: string): Promise<MarketReadiness> {
    const components: ComponentReadiness[] = [];

    // ── Email. SES everywhere; the same provider serves every market. ──
    const emailProvider = this.config.get<string>('EMAIL_PROVIDER') ?? 'log';
    if (emailProvider === 'log') {
      components.push({
        key: 'email',
        label: 'Email',
        state: 'MISSING',
        // The boot guard already refuses this in production; said again here so an operator
        // preparing a launch sees it before the deploy rather than during it.
        detail: 'EMAIL_PROVIDER=log writes to the service log and SENDS NOTHING.',
      });
    } else {
      const creds =
        emailProvider === 'ses' ? ['AWS_REGION', 'EMAIL_FROM'] : ['SENDGRID_API_KEY', 'EMAIL_FROM'];
      const check = this.require('email', `Email (${emailProvider})`, creds);
      if (check.state === 'CONFIGURED' && !(await this.rate(emailProvider, 'email', market))) {
        check.state = 'PARTIAL';
        check.detail = 'Sends, but has no rate configured — cost will report as UNKNOWN.';
      }
      components.push(check);
    }

    // ── SMS and WhatsApp, whichever provider this market routes to. ──
    for (const channel of ['sms', 'whatsapp'] as const) {
      const provider = this.providerFor(channel, market);
      const label = channel === 'sms' ? 'SMS' : 'WhatsApp';
      if (!provider || provider === 'log') {
        components.push({
          key: channel,
          label,
          state: 'DISABLED',
          detail: `No provider routed for ${market}. Set ${
            channel === 'sms' ? 'SMS_PROVIDER_BY_MARKET' : 'WHATSAPP_PROVIDER_BY_MARKET'
          }.`,
        });
        continue;
      }
      const creds = this.providerCredentials(provider);
      const check = creds
        ? this.require(channel, `${label} (${provider})`, creds.keys)
        : { key: channel, label, state: 'MISSING' as ReadinessState };

      if (check.state === 'CONFIGURED') {
        const missing: string[] = [];
        if (!(await this.rate(provider, channel, market))) missing.push('no rate configured');
        /*
          MSG91 will carry nothing without an approved template, so a configured key alone is
          not readiness — it is the appearance of it, which is worse.
        */
        if (provider === 'msg91' && channel === 'sms' && !this.set('MSG91_SMS_TEMPLATE_IDS')) {
          missing.push('no DLT template ids (MSG91_SMS_TEMPLATE_IDS)');
        }
        if (provider === 'msg91' && channel === 'whatsapp') {
          if (!this.set('MSG91_WHATSAPP_NUMBER')) missing.push('MSG91_WHATSAPP_NUMBER');
          if (!this.set('MSG91_WHATSAPP_TEMPLATES')) missing.push('MSG91_WHATSAPP_TEMPLATES');
        }
        if (missing.length > 0) {
          check.state = 'PARTIAL';
          check.detail = `Still missing: ${missing.join(', ')}.`;
        }
      }
      components.push(check);
    }

    // ── Push. One provider for every market; the device token names its own service. ──
    const pushProvider = this.config.get<string>('PUSH_PROVIDER') ?? 'log';
    components.push(
      pushProvider === 'log'
        ? { key: 'push', label: 'Push', state: 'DISABLED', detail: 'PUSH_PROVIDER=log.' }
        : pushProvider === 'fcm'
          ? this.require('push', 'Push (FCM)', [
              'FCM_PROJECT_ID',
              'FCM_CLIENT_EMAIL',
              'FCM_PRIVATE_KEY',
            ])
          : {
              key: 'push',
              label: 'Push (Expo)',
              state: 'CONFIGURED',
              // Expo needs no credential for ordinary sends: the device token authorises
              // delivery to that installation.
              detail: 'Expo needs no credential unless enhanced security is switched on.',
            },
    );

    // ── Delivery callbacks. Presence of a secret, and nothing more is claimed. ──
    components.push(this.deliveryCallbacks(market));

    const ok = components.every((c) => c.state === 'CONFIGURED' || c.state === 'DISABLED');
    return { market, ok, components };
  }

  private deliveryCallbacks(market: string): ComponentReadiness {
    const expected: string[] = ['SES_WEBHOOK_SECRET'];
    if (this.providerFor('sms', market) === 'twilio') expected.push('PUBLIC_API_URL');
    if (this.providerFor('sms', market) === 'msg91') expected.push('MSG91_WEBHOOK_SECRET');
    if (this.providerFor('whatsapp', market) === 'msg91') expected.push('MSG91_WEBHOOK_SECRET');
    if (this.providerFor('whatsapp', market) === 'cloud') expected.push('WHATSAPP_APP_SECRET');

    const check = this.require('delivery-callbacks', 'Delivery callbacks', [...new Set(expected)]);
    /*
      Whether the provider is actually POSTING to us is a fact about their dashboard, which
      nothing here can observe. Saying so explicitly is the difference between a readiness
      report and a false assurance.
    */
    check.detail = `${check.detail ? `${check.detail} ` : ''}Configuration only — this does not prove the provider is delivering callbacks.`;
    return check;
  }

  /** Every launch market, plus the platform-wide switches an operator needs to see. */
  async report(markets: string[] = ['IN', 'US', 'CA']) {
    const perMarket = await Promise.all(markets.map((m) => this.forMarket(m)));
    return {
      markets: perMarket,
      platform: {
        whatsappOptInEnforced:
          this.config.get<string>('WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED') === 'true',
        remindersEnabled: this.config.get<string>('NOTIFICATION_REMINDERS_ENABLED') === 'true',
        reminderLeadHours: Number(this.config.get('NOTIFICATION_REMINDER_LEAD_HOURS') ?? 24),
        activeRates: await this.prisma.notificationRate.count({ where: { active: true } }),
      },
      ok: perMarket.every((m) => m.ok),
    };
  }
}
