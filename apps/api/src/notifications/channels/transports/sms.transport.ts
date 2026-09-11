import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio, { Twilio } from 'twilio';
import { FailureClass, SuppressionReason, failureClassForStatus } from '@eticketsgo/shared-types';
import type { TemplateBindingService } from '../../templates/template-binding.service';
import { DeliveryOutcome, RenderedNotification } from '../notification-channel.interface';
import { maskPhone, resolveDestination } from './recipient.util';
import { TransportError, transportJson } from './transport-http';
import { messageContentLoggable } from './content-logging';
import { redactProviderText } from './provider-text';

/** DI token for the SMS transport bound in notifications.module.ts. */
export const SMS_TRANSPORT = Symbol('SMS_TRANSPORT');

/** Which real/log transport an SMS route resolves to. */
export type SmsProviderName = 'log' | 'twilio' | 'msg91';

/** A single SMS-send transport. */
export interface SmsTransport {
  readonly name: SmsProviderName;
  /**
   * The provider itself refuses to text a number that has opted out, and stops refusing when
   * the person opts back in. When that is true, a message this transport got ACCEPTED is proof
   * the recipient is currently opted in -- which is the only way this platform learns about a
   * START, because inbound replies go to the provider, not to us.
   */
  readonly enforcesOptOut?: boolean;
  send(msg: RenderedNotification): Promise<DeliveryOutcome>;
}

/** Nothing to send to. Not a failure — see DeliveryOutcome. */
function noRecipient(msg: RenderedNotification, logger: Logger, provider: string): DeliveryOutcome {
  logger.warn(
    `[sms:${msg.type}] no phone number on file -> skipped for user ${msg.userId ?? 'n/a'}`,
  );
  return { provider, skipped: true, reason: 'no_destination' };
}

/**
 * Sends nothing; says so in the log.
 *
 * ── WHY THE BODY IS WITHHELD OUTSIDE LOCAL/DEV ─────────────────────────────────────
 * This transport printed every body unconditionally, and QA and UAT run it -- so every phone
 * sign-in code requested there was written, in the clear, to a log that is retained and
 * readable by anyone with access to the project. On a developer's laptop that is the point of
 * the transport; anywhere else it is a credential in a log. See `messageContentLoggable`.
 */
export class SmsLogTransport implements SmsTransport {
  readonly name = 'log' as const;
  private readonly logger = new Logger('Notification');
  private readonly printBodies: boolean;

  constructor(config?: Pick<ConfigService, 'get'>) {
    this.printBodies = messageContentLoggable(config);
  }

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    if (this.printBodies) {
      this.logger.log(`[sms:${msg.type}] -> user ${msg.userId ?? 'n/a'} :: ${msg.body}`);
    } else {
      this.logger.log(
        `[sms:${msg.type}] not sent (SMS is in log mode); content withheld -> ` +
          `${maskPhone(resolveDestination(msg))}`,
      );
    }
    return { provider: 'log' };
  }
}

/**
 * Twilio transport (United States and Canada). Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 * and TWILIO_MESSAGING_SERVICE_SID.
 *
 * ── WHY A MESSAGING SERVICE AND NEVER A FROM NUMBER ────────────────────────────────
 * This sent `{ to, from, body }`, and a message sent that way asks Twilio for no delivery
 * callbacks at all: Twilio reports status for a message only to a StatusCallback passed with
 * it, or to the Delivery Status Callback of the Messaging Service it was sent through. With
 * neither, every SMS would have stayed ACCEPTED forever, no STOP would ever have suppressed
 * anything, and readiness would have been green.
 *
 * The Messaging Service is also where the sender pool, the carrier registration (toll-free
 * verification or A2P 10DLC) and Twilio's opt-out handling live, so it is the one place a
 * change of number is made without a deploy. `from` and `messagingServiceSid` are never both
 * sent: Twilio would choose between them, and the answer to "which sender carried this" must
 * be the configuration, not Twilio's precedence rules.
 */
export class TwilioSmsTransport implements SmsTransport {
  readonly name = 'twilio' as const;
  readonly enforcesOptOut = true;
  private readonly logger = new Logger('Notification');
  private readonly client: Twilio;
  private readonly messagingServiceSid: string;

  constructor(config: ConfigService) {
    const accountSid = requireKey(config, 'twilio', 'TWILIO_ACCOUNT_SID');
    const authToken = requireKey(config, 'twilio', 'TWILIO_AUTH_TOKEN');
    this.messagingServiceSid = requireKey(config, 'twilio', 'TWILIO_MESSAGING_SERVICE_SID');
    this.client = twilio(accountSid, authToken);
  }

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    const to = resolveDestination(msg);
    if (!to) return noRecipient(msg, this.logger, this.name);
    try {
      const created = await this.client.messages.create({
        to,
        messagingServiceSid: this.messagingServiceSid,
        body: msg.body,
      });
      return { provider: this.name, providerMessageId: created.sid };
    } catch (err) {
      /*
        The Twilio SDK throws its own error object rather than returning a status, so nothing
        upstream could classify it: an unroutable number, a suspended account and a genuine
        outage all arrived as the same unrecognised throw and were filed as "Twilio
        unavailable". Twilio's numeric codes are published and stable, and they are the only
        thing that separates "this number does not exist" from "try again".
      */
      throw classifyTwilioError(err, this.name);
    }
  }
}

/**
 * Twilio's published error codes, narrowed to the distinctions that change what we do.
 *
 * ── WHY THE MESSAGE IS SANITIZED HERE ──────────────────────────────────────────────
 * Twilio's error prose names the number it refused. This error becomes `failureReason`,
 * `Notification.lastError`, a log line and possibly a Sentry event, so the number is removed
 * at the one place the text enters the platform, and the CODE travels separately where it is
 * safe to keep.
 */
export function classifyTwilioError(err: unknown, provider: string): TransportError {
  if (err instanceof TransportError) return err;
  const e = err as { code?: number | string; status?: number; message?: string } | null;
  const numeric = Number(e?.code);
  const providerCode = Number.isFinite(numeric) ? String(numeric) : undefined;
  const detail = redactProviderText(e?.message ?? String(err)).slice(0, 300);
  const cls = (() => {
    switch (numeric) {
      // 21211/21614: not a valid or SMS-capable number. 21610: the recipient sent STOP.
      case 21211:
      case 21214:
      case 21614:
        return FailureClass.INVALID_DESTINATION;
      case 21610:
        return FailureClass.COMPLIANCE_BLOCKED;
      // 20003 authenticate, 20005 account not active, 20429 too many requests.
      case 20003:
      case 20005:
        return FailureClass.AUTHENTICATION_ERROR;
      case 20429:
        return FailureClass.RATE_LIMIT;
      // 30032 unverified toll-free, 30034 unregistered 10DLC: the sender is not permitted.
      case 30032:
      case 30034:
        return FailureClass.COMPLIANCE_BLOCKED;
      /*
        Our own setup, and nothing a retry fixes: 20404 a Messaging Service or account that
        does not exist, 21212/21606 a sender that is not ours to use, 21408 a destination
        region not enabled in Geographic Permissions, 21608 a trial account texting a number
        it has not verified.
      */
      case 20404:
      case 21212:
      case 21408:
      case 21606:
      case 21608:
        return FailureClass.CONFIGURATION_ERROR;
      default:
        return typeof e?.status === 'number'
          ? failureClassForStatus(e.status)
          : FailureClass.UNKNOWN_PROVIDER_ERROR;
    }
  })();
  return new TransportError(
    `twilio${providerCode ? ` error ${providerCode}` : ''}: ${detail}`,
    provider,
    cls,
    typeof e?.status === 'number' ? e.status : undefined,
    {
      providerCode,
      suppression: numeric === 21610 ? SuppressionReason.UNSUBSCRIBED : undefined,
    },
  );
}

/**
 * MSG91 transport (India).
 *
 * ── WHY INDIA CANNOT USE TWILIO'S SHAPE ────────────────────────────────────────────
 * An Indian operator will not carry a transactional SMS whose wording is not a template
 * registered against the sender on a DLT portal, and will not carry it under a sender id
 * that is not registered either. So there is no "here is some text, send it": the request
 * names an APPROVED TEMPLATE and supplies its variables, and the approved wording lives at
 * the operator, not in this repository.
 *
 * That is why the template ids are configuration and why none of them have defaults. A
 * hardcoded template id is a compliance decision baked into a build, and a wrong one is a
 * message that is accepted by the API and then silently dropped by the carrier.
 *
 * ── WHAT MUST BE SET UP OUTSIDE THIS CODE ──────────────────────────────────────────
 * An MSG91 account, a DLT-registered sender id, and one approved template per message type,
 * with its variable names. None of that can be created from here and none of it is faked in
 * tests: with no template id configured for a type this transport refuses the send with a
 * permanent error rather than guessing one.
 *
 * ── ON THE REQUEST SHAPE ───────────────────────────────────────────────────────────
 * This is written against MSG91's published v5 flow API. The base URL and path are
 * configurable precisely because a vendor's API is not something this repository can assert
 * from the outside: verify it against the account's own documentation before enabling, which
 * is what EXTERNAL SETUP REQUIRED in the report means.
 */
export class Msg91SmsTransport implements SmsTransport {
  readonly name = 'msg91' as const;
  private readonly logger = new Logger('Notification');
  private readonly authKey: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly templateIds: Record<string, string>;
  private readonly defaultTemplateId?: string;
  private readonly senderId?: string;
  private readonly bodyVar: string;
  /**
   * The canonical binding source, when one is wired.
   *
   * Optional because this transport is constructed directly in tests and by the legacy
   * single-provider factory, and neither has a Nest container to hand. Absent, the
   * environment maps below are the whole answer -- which is exactly the behaviour that
   * shipped before, so nothing that works today stops working.
   */
  private readonly bindings?: TemplateBindingService;

  constructor(config: ConfigService, bindings?: TemplateBindingService) {
    this.authKey = requireKey(config, 'msg91', 'MSG91_AUTH_KEY');
    const base = (config.get<string>('MSG91_BASE_URL') ?? 'https://control.msg91.com').replace(
      /\/+$/,
      '',
    );
    this.url = `${base}${config.get<string>('MSG91_SMS_PATH') ?? '/api/v5/flow'}`;
    this.timeoutMs = Number(config.get('MSG91_TIMEOUT_MS') ?? 10_000);
    this.templateIds = parseTemplateIds(config.get<string>('MSG91_SMS_TEMPLATE_IDS'));
    this.defaultTemplateId = config.get<string>('MSG91_SMS_TEMPLATE_ID') ?? undefined;
    this.bindings = bindings;
    this.senderId = config.get<string>('MSG91_SENDER_ID') ?? undefined;
    this.bodyVar = config.get<string>('MSG91_SMS_BODY_VAR') ?? 'body';
  }

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    const to = resolveDestination(msg);
    if (!to) return noRecipient(msg, this.logger, this.name);

    /*
      Locale first, because a DLT template is approved for one wording in one language and
      the ids differ. The legacy map has no locale, so it answers for every language -- which
      is what it always did, and why it resolves after the canonical binding rather than
      before it.
    */
    const bound = this.bindings?.resolve({
      provider: this.name,
      channel: 'sms',
      type: msg.type,
      locale: msg.locale,
    });
    const templateId = bound?.externalId ?? this.templateIds[msg.type] ?? this.defaultTemplateId;
    if (!templateId) {
      /*
        Permanent on purpose. There is no template to retry with, and retrying twelve times
        over an hour would only delay the moment somebody notices the configuration is
        incomplete. The message names the exact key to set.
      */
      throw new TransportError(
        `MSG91 has no DLT template bound for ${msg.type} (locale ${msg.locale ?? '*'}). ` +
          `Set NOTIFICATION_TEMPLATE_BINDINGS=msg91:sms:${msg.type}:*=<dlt_template_id>.`,
        this.name,
        FailureClass.TEMPLATE_NOT_FOUND,
      );
    }

    /*
      Structured variables from the caller when it has them, otherwise the rendered message as
      one variable. Both exist because a DLT template can be either shape: a sentence with
      named slots ("Your booking ##ref## is confirmed"), or a single variable that the
      approved wording wraps. Which one an account has is the account's business.
    */
    const vars =
      (msg.payload?.['smsTemplateVars'] as Record<string, unknown> | undefined) ??
      ({ [this.bodyVar]: msg.body } as Record<string, unknown>);

    const { data } = await transportJson<Msg91Response>(this.name, this.url, {
      method: 'POST',
      timeoutMs: this.timeoutMs,
      headers: {
        // MSG91 authenticates with this header. It is never logged and never echoed back.
        authkey: this.authKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        template_id: templateId,
        ...(this.senderId ? { sender: this.senderId } : {}),
        short_url: '0',
        realTimeResponse: '1',
        // MSG91 wants the number without a leading '+'.
        recipients: [{ mobiles: to.replace(/^\+/, ''), ...vars }],
      }),
    });

    /*
      MSG91 answers HTTP 200 for a refusal as well as an acceptance, distinguishing them in
      `type`. Treating 200 as success would record "sent" for messages the provider had just
      told us it would not carry — which is the exact class of lie this phase set out to
      remove from the status column.
    */
    if (data?.type && data.type !== 'success') {
      throw new TransportError(
        `MSG91 refused the message: ${data.message ?? data.type}`,
        this.name,
        // MSG91 answers 200 for a refusal, so this is the provider having considered the
        // message and declined it -- their answer, not our configuration.
        FailureClass.PERMANENT_REJECTION,
      );
    }
    this.logger.log(`[sms:${msg.type}] msg91 accepted -> ${maskPhone(to)}`);
    return {
      provider: this.name,
      providerMessageId: typeof data?.message === 'string' ? data.message : null,
    };
  }
}

interface Msg91Response {
  type?: string;
  message?: string;
}

/** `BOOKING_CANCELLED=1234,REFUND_COMPLETED=5678` → a lookup by notification type. */
export function parseTemplateIds(raw: string | null | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of (raw ?? '').split(',')) {
    const [type, id] = entry.split('=');
    if (type?.trim() && id?.trim()) map[type.trim()] = id.trim();
  }
  return map;
}

/** Construct one named SMS transport. Only the ones a route needs are ever built. */
export function buildSmsTransport(
  name: SmsProviderName,
  config: ConfigService,
  bindings?: TemplateBindingService,
): SmsTransport {
  switch (name) {
    case 'twilio':
      return new TwilioSmsTransport(config);
    case 'msg91':
      return new Msg91SmsTransport(config, bindings);
    case 'log':
    default:
      return new SmsLogTransport(config);
  }
}

/**
 * Resolves the DEFAULT SMS transport from SMS_PROVIDER (default `log`) — the answer when no
 * market routing table is configured, which is every single-market and local setup.
 */
export function selectSmsTransport(config: ConfigService): SmsTransport {
  return buildSmsTransport(config.get<SmsProviderName>('SMS_PROVIDER') ?? 'log', config);
}

/**
 * A credential this transport cannot work without.
 *
 * -- WHY IT THROWS A TransportError AND NOT A BARE Error ---------------------------
 * It threw a plain `Error` before, which the dispatch loop could not classify -- so a market
 * with no MSG91 account produced three retries, a fifteen-second gap, and a row filed against
 * MSG91's reliability for a provider we had never called. It is a `CONFIGURATION_ERROR`: not
 * retryable, not the provider's, and visible to an operator as work for them.
 */
function requireKey(config: ConfigService, provider: string, key: string): string {
  const value = config.get<string>(key);
  if (!value) {
    throw new TransportError(
      `SMS provider "${provider}" requires ${key} to be set. ` +
        `Use sandbox credentials for QA, live credentials for production.`,
      provider,
      FailureClass.CONFIGURATION_ERROR,
    );
  }
  return value;
}
