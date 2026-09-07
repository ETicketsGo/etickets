import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  parseMarketProviderMap,
  routeNotificationProvider,
  type NotificationRoute,
} from '@eticketsgo/shared-types';
import { TemplateBindingService } from '../templates/template-binding.service';
import type { RenderedNotification } from './notification-channel.interface';
import { resolveDestination } from './transports/recipient.util';
import {
  buildSmsTransport,
  type SmsProviderName,
  type SmsTransport,
} from './transports/sms.transport';
import {
  buildWhatsAppTransport,
  type WhatsAppProviderName,
  type WhatsAppTransport,
} from './transports/whatsapp.transport';

/**
 * Which provider carries this message, given where it is going.
 *
 * ── WHY THIS IS A RESOLVER AND NOT A CONDITIONAL ───────────────────────────────────
 * Each channel used to be handed ONE transport, constructed once at module boot from one
 * environment variable. That is a per-process answer to a per-message question, and it is
 * why "India goes to MSG91, North America goes to Twilio" could not be expressed at all —
 * not because anybody decided against it, but because there was nowhere to put it.
 *
 * The alternative — a country check at each call site — spreads a routing decision across
 * every service that sends anything, where it will be got wrong once and then copied.
 *
 * ── WHY IT IS SHAPED LIKE PaymentProviderResolver ──────────────────────────────────
 * Because that one already works. Stripe and Razorpay run simultaneously in this process
 * today: adapters are constructed LAZILY on first use and cached, so boot never needs every
 * provider's credentials, and a provider whose keys are missing fails loudly at construction
 * rather than silently falling back to another. Every one of those properties is wanted here,
 * so this copies the shape instead of inventing a second one.
 */
@Injectable()
export class NotificationProviderResolver {
  private readonly logger = new Logger('Notification');
  private readonly smsCache = new Map<string, SmsTransport>();
  private readonly whatsAppCache = new Map<string, WhatsAppTransport>();

  constructor(
    private readonly config: ConfigService,
    /*
      Optional so the resolver can still be constructed in tests that care only about
      routing. Absent, the transports fall back to their environment template maps, which is
      exactly the behaviour that shipped before bindings existed.
    */
    private readonly bindings?: TemplateBindingService,
  ) {}

  /** The SMS transport for one message, or a refusal explaining why there is none. */
  routeSms(msg: RenderedNotification): Routed<SmsTransport> {
    return this.route(
      msg,
      'SMS_PROVIDER_BY_MARKET',
      this.config.get<SmsProviderName>('SMS_PROVIDER') ?? 'log',
      (name) => this.getSms(name as SmsProviderName),
    );
  }

  /** The WhatsApp transport for one message, or a refusal. */
  routeWhatsApp(msg: RenderedNotification): Routed<WhatsAppTransport> {
    return this.route(
      msg,
      'WHATSAPP_PROVIDER_BY_MARKET',
      this.config.get<WhatsAppProviderName>('WHATSAPP_PROVIDER') ?? 'log',
      (name) => this.getWhatsApp(name as WhatsAppProviderName),
    );
  }

  private route<T>(
    msg: RenderedNotification,
    mapKey: string,
    defaultProvider: string,
    build: (name: string) => T,
  ): Routed<T> {
    const decision: NotificationRoute = routeNotificationProvider({
      marketProviders: parseMarketProviderMap(this.config.get<string>(mapKey)),
      defaultProvider,
      // Trusted business context first; the destination number otherwise. Neither comes
      // from a browser: `country` is set by the sending service from its own records.
      country: msg.country,
      destination: resolveDestination(msg),
    });

    if (!decision.ok) {
      /*
        Refused, not defaulted. Sending an Indian number through a North American route is
        not a degraded success — it is a message the carrier drops, billed at an
        international rate, and nobody finds out until a customer says their ticket never
        arrived. A FAILED row with a reason on it is the outcome that gets looked at.
      */
      this.logger.warn(
        `[${msg.channel}:${msg.type}] no provider route (${decision.refusal}` +
          `${decision.market ? `, market ${decision.market}` : ''})`,
      );
      return { ok: false, refusal: decision.refusal, market: decision.market };
    }
    return {
      ok: true,
      transport: build(decision.provider),
      provider: decision.provider,
      market: decision.market,
    };
  }

  /** Construct-on-first-use + cache, exactly as the payment registry does. */
  private getSms(name: SmsProviderName): SmsTransport {
    const existing = this.smsCache.get(name);
    if (existing) return existing;
    const built = buildSmsTransport(name, this.config, this.bindings);
    this.smsCache.set(name, built);
    return built;
  }

  private getWhatsApp(name: WhatsAppProviderName): WhatsAppTransport {
    const existing = this.whatsAppCache.get(name);
    if (existing) return existing;
    const built = buildWhatsAppTransport(name, this.config, this.bindings);
    this.whatsAppCache.set(name, built);
    return built;
  }
}

export type Routed<T> =
  | { ok: true; transport: T; provider: string; market: string | null }
  | { ok: false; refusal: string; market: string | null };
