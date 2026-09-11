import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  parseEnabledMarkets,
  parseMarketProviderMap,
  requiresTemplateBinding,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { TemplateBindingService } from '../templates/template-binding.service';
import { fallbackChannelFor, immediateChannels } from '../policy/notification-policy';
import { NotificationType, WebhookProcessingStatus } from '@eticketsgo/shared-types';
import { messageContentLoggable } from '../channels/transports/content-logging';

export type ReadinessState =
  | 'CONFIGURED'
  | 'PARTIAL'
  | 'MISSING'
  | 'DISABLED'
  /**
   * India SMS specifically, blocked on a telecom registration nobody here can complete.
   *
   * -- WHY IT IS NOT JUST MISSING -----------------------------------------------------
   * MISSING reads as "somebody forgot to set a variable", and the fix for that is five
   * minutes. This is a registration with a telecom operator that takes days, involves a
   * legal entity, and gates every SMS the platform will ever send in India. Reporting the
   * two the same way puts a launch-blocking dependency in the same column as a typo.
   */
  | 'BLOCKED_DLT';

export interface ComponentReadiness {
  key: string;
  label: string;
  state: ReadinessState;
  /** Never a secret. Names the KEY that is unset, never any part of its value. */
  detail?: string;
  /**
   * The deficiencies, separated so a reader can reason rather than parse.
   *
   * ── WHY THIS IS NOT JUST `detail` ──────────────────────────────────────────────────
   * A missing credential and a missing RATE are both "PARTIAL" and are not the same problem:
   * the first means nothing can be sent, the second means everything sends and nothing can be
   * costed. The certification ladder treats them as different rungs, and text-matching a
   * prose string to tell them apart is the kind of coupling that breaks the day somebody
   * improves the wording.
   */
  missingCredentials?: string[];
  missingRate?: boolean;
  /** Provider-side artefacts that only exist in somebody's console — DLT templates, numbers. */
  missingExternal?: string[];
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
    private readonly bindings: TemplateBindingService,
  ) {}

  /** The markets this deployment says it is open in. */
  enabledMarkets(): string[] {
    return parseEnabledMarkets(this.config.get<string>('NOTIFICATION_MARKETS'));
  }

  private set(key: string): boolean {
    const v = this.config.get<string>(key);
    return typeof v === 'string' && v.trim().length > 0;
  }

  /** CONFIGURED when every key is set, MISSING when none are, PARTIAL in between. */
  private require(key: string, label: string, keys: string[]): ComponentReadiness {
    const missing = keys.filter((k) => !this.set(k));
    if (missing.length === 0) return { key, label, state: 'CONFIGURED' };
    if (missing.length === keys.length) {
      return {
        key,
        label,
        state: 'MISSING',
        detail: `Set ${keys.join(', ')}.`,
        missingCredentials: missing,
      };
    }
    return {
      key,
      label,
      state: 'PARTIAL',
      detail: `Still missing: ${missing.join(', ')}.`,
      missingCredentials: missing,
    };
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
          keys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID'],
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

  /**
   * Which India DLT facts are still unrecorded.
   *
   * Recorded, not verified. Nothing here contacts a telecom system, and it must not: this
   * platform can say what it was told and cannot say whether an operator has approved it.
   * A populated list means the platform has not even been told, which is a strictly earlier
   * problem than an approval being pending.
   */
  private dltGaps(): string[] {
    const gaps: string[] = [];
    if (!this.set('DLT_PRINCIPAL_ENTITY_ID')) gaps.push('DLT_PRINCIPAL_ENTITY_ID (PE ID)');
    if (!this.set('DLT_SENDER_HEADER') && !this.set('MSG91_SENDER_ID')) {
      gaps.push('DLT_SENDER_HEADER (registered sender header)');
    }
    if (this.unboundTypes('msg91', 'sms').length > 0) {
      gaps.push('approved DLT template ids');
    }
    return gaps;
  }

  /**
   * Notification types this channel is asked to carry with no template bound for them.
   *
   * Driven by POLICY rather than by a hand-kept list: the types a channel carries is
   * already declared once, and a second copy here would be wrong the first time somebody
   * changed the policy table.
   */
  private unboundTypes(provider: string, channel: string): string[] {
    const types = Object.values(NotificationType).filter((t) =>
      immediateChannels(t).includes(channel as never),
    );
    /*
      SMS is a FALLBACK target, so it is deliberately absent from `immediateChannels` --
      which would report nothing to bind for a channel that genuinely needs a template. The
      fallback target is added back for exactly the types whose policy names it.
    */
    const viaFallback = Object.values(NotificationType).filter(
      (t) => fallbackChannelFor(t) === channel,
    );
    const all = [...new Set([...types, ...viaFallback])];
    return all
      .filter((t) => !this.bindings.resolve({ provider, channel, type: t, locale: null }))
      .map((t) => String(t));
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
      if (check.state === 'CONFIGURED') {
        const external: string[] = [];
        /*
          SES publishes delivery, bounce and complaint events ONLY for messages sent with a
          configuration set that has an event destination. Without it everything looks
          healthy -- mail goes out, the API returns a message id, the row says ACCEPTED --
          and not one callback ever arrives, so nothing is marked delivered and no bounce
          ever suppresses anything. Configured-but-deaf is PARTIAL, not READY.
        */
        if (emailProvider === 'ses' && !this.set('SES_CONFIGURATION_SET')) {
          external.push('SES_CONFIGURATION_SET (no delivery events without it)');
        }
        const noRate = !(await this.rate(emailProvider, 'email', market));
        if (external.length > 0 || noRate) {
          check.state = 'PARTIAL';
          check.missingExternal = external.length > 0 ? external : undefined;
          check.missingRate = noRate || undefined;
          check.detail = `Still missing: ${[
            ...external,
            ...(noRate ? ['no rate configured'] : []),
          ].join(', ')}.`;
        }
      }
      components.push(check);
    }

    // ── SMS and WhatsApp, whichever provider this market routes to. ──
    for (const channel of ['sms', 'whatsapp'] as const) {
      const provider = this.providerFor(channel, market);
      const label = channel === 'sms' ? 'SMS' : 'WhatsApp';
      if (provider === 'log') {
        /*
          Log mode sends nothing. In QA or UAT that is a deliberate choice for a market not
          being tested; where customers are served it means phone sign-in cannot work, and the
          boot guard refuses it -- said again here so it is seen before the deploy.
        */
        const customerFacing = ['STAGING', 'PRODUCTION'].includes(
          this.config.get<string>('APP_ENV') ?? 'LOCAL',
        );
        components.push({
          key: channel,
          label,
          state: customerFacing ? 'MISSING' : 'DISABLED',
          detail:
            `${label} for ${market} is in log mode: nothing is sent, and message content is ` +
            `withheld from the log outside LOCAL/DEV.` +
            (customerFacing ? ' Production refuses to boot this way.' : ''),
        });
        continue;
      }
      if (!provider) {
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
        const external: string[] = [];
        /*
          A provider that will carry NOTHING without an approved template is not ready
          because its credential is set -- that is the appearance of readiness, which is
          worse than its absence. Asked per notification TYPE, because policy selects
          different types on different channels and one bound template does not cover the
          five that WhatsApp carries.
        */
        if (requiresTemplateBinding(provider, channel)) {
          const unbound = this.unboundTypes(provider, channel);
          if (unbound.length > 0) {
            external.push(`approved templates for ${unbound.join(', ')}`);
          }
        }
        if (provider === 'msg91' && channel === 'whatsapp' && !this.set('MSG91_WHATSAPP_NUMBER')) {
          external.push('MSG91_WHATSAPP_NUMBER');
        }
        const noRate = !(await this.rate(provider, channel, market));

        if (external.length > 0 || noRate) {
          check.state = 'PARTIAL';
          check.missingExternal = external.length > 0 ? external : undefined;
          check.missingRate = noRate || undefined;
          check.detail = `Still missing: ${[
            ...external,
            ...(noRate ? ['no rate configured'] : []),
          ].join(', ')}.`;
        }
      }

      /*
        India SMS is not merely unconfigured, it is BLOCKED on a registration with a telecom
        operator. Said in its own state so a launch review can tell a variable somebody
        forgot from a dependency measured in days.
      */
      if (channel === 'sms' && market === 'IN' && provider === 'msg91') {
        const dlt = this.dltGaps();
        if (dlt.length > 0) {
          check.state = 'BLOCKED_DLT';
          check.missingExternal = [...(check.missingExternal ?? []), ...dlt];
          check.detail =
            `Blocked on DLT registration: ${dlt.join(', ')}. ` +
            `None of this can be completed from this repository.`;
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
    if (this.providerFor('whatsapp', market) === 'cloud') {
      expected.push('WHATSAPP_APP_SECRET');
      // Without the verify token Meta cannot ACTIVATE the subscription, so the (correct)
      // status handler is never called. A missing token is not a degraded callback: it is no
      // callback at all, and it looks identical to the provider being quiet.
      expected.push('WHATSAPP_VERIFY_TOKEN');
    }

    const check = this.require('delivery-callbacks', 'Delivery callbacks', [...new Set(expected)]);
    /*
      The exact URL to paste into the Messaging Service. Not a secret -- Twilio authenticates
      with a signature, not with the URL -- and getting it byte-for-byte right is the whole
      difficulty, so it is computed from the same values the controller uses to verify.
    */
    const twilioCallback = this.twilioWebhookUrl('twilio');
    const twilioInbound = this.twilioWebhookUrl('twilio/inbound');
    const where =
      this.providerFor('sms', market) === 'twilio' && twilioCallback && twilioInbound
        ? `Twilio: on the Messaging Service set the Delivery Status Callback to ` +
          `${twilioCallback}, set Incoming Messages to send a webhook to ${twilioInbound}, and ` +
          `enable Advanced Opt-Out — without it STOP/START never reach this platform and ` +
          `opt-out state cannot follow Twilio. `
        : '';
    /*
      Whether the provider is actually POSTING to us is a fact about their dashboard, which
      nothing here can observe. Saying so explicitly is the difference between a readiness
      report and a false assurance.
    */
    check.detail = `${check.detail ? `${check.detail} ` : ''}${where}Configuration only — this does not prove the provider is delivering callbacks.`;
    return check;
  }

  /** `${PUBLIC_API_URL}/${prefix}/notifications/webhooks/${route}`, or null when unset. */
  private twilioWebhookUrl(route: string): string | null {
    const base = (this.config.get<string>('PUBLIC_API_URL') ?? '').trim().replace(/\/+$/, '');
    if (!base) return null;
    const prefix = (this.config.get<string>('API_GLOBAL_PREFIX') ?? 'api').replace(
      /^\/+|\/+$/g,
      '',
    );
    return `${base}${prefix ? `/${prefix}` : ''}/notifications/webhooks/${route}`;
  }

  private async awaitingCorrelation(): Promise<number | null> {
    const ledger = (this.prisma as { webhookEvent?: PrismaService['webhookEvent'] }).webhookEvent;
    if (!ledger) return null;
    return ledger
      .count({
        where: {
          provider: { startsWith: 'notification:' },
          processingStatus: WebhookProcessingStatus.AWAITING_CORRELATION,
        },
      })
      .catch(() => null);
  }

  /** Every ENABLED market, plus the platform-wide switches an operator needs to see. */
  async report(markets?: string[]) {
    const wanted = markets ?? this.enabledMarkets();
    const perMarket = await Promise.all(wanted.map((m) => this.forMarket(m)));
    return {
      markets: perMarket,
      /*
        Named explicitly rather than left implicit in the list above, so a reader can tell
        "Canada is fine" from "Canada was never asked about".
      */
      enabledMarkets: this.enabledMarkets(),
      platform: {
        whatsappOptInEnforced:
          this.config.get<string>('WHATSAPP_TRANSACTIONAL_OPT_IN_REQUIRED') === 'true',
        remindersEnabled: this.config.get<string>('NOTIFICATION_REMINDERS_ENABLED') === 'true',
        reminderLeadHours: Number(this.config.get('NOTIFICATION_REMINDER_LEAD_HOURS') ?? 24),
        activeRates: await this.prisma.notificationRate.count({ where: { active: true } }),
        /*
          Bindings still coming from the superseded per-provider keys. Not a fault -- they
          work -- but they carry no locale, so a French message resolves to a template
          approved in English. Worth migrating deliberately rather than discovering.
        */
        legacyTemplateBindings: this.bindings.legacyCount(),
        /*
          Whether this process would print a message body -- a sign-in code included -- when a
          channel is in log mode. False everywhere but LOCAL/DEV; shown so nobody has to read
          the code to find out.
        */
        messageContentLogged: messageContentLoggable(this.config),
        /*
          Verified callbacks still waiting for their message to be recorded. A handful is the
          normal race; a growing number means sends are crashing before their provider
          reference is written, or another environment shares this provider account.
        */
        callbacksAwaitingCorrelation: await this.awaitingCorrelation(),
      },
      ok: perMarket.every((m) => m.ok),
    };
  }
}
