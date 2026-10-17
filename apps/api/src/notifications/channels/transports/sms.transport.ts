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
import {
  DLT_ID_PATTERN,
  DLT_VARIABLE_MAX_LENGTH,
  OTP_SMS_KIND,
  REJECTED_SENDER_HEADERS,
  dltVariablesFromPayload,
  matchDltSms,
  selectDltTemplate,
  type DltSmsTemplate,
} from '../../templates/dlt-sms-templates';

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
 * registered against the sender on a DLT portal, and will not carry it under a sender header
 * that is not registered either. So there is no "here is some text, send it": the request
 * names an APPROVED TEMPLATE and supplies its variables.
 *
 * ── WHAT CHANGED, AND WHY ──────────────────────────────────────────────────────────
 * This used to send the catalogue's rendered body as one variable (`MSG91_SMS_BODY_VAR`), fall
 * back to one shared template id for every type (`MSG91_SMS_TEMPLATE_ID`), and send whatever a
 * payload put in `smsTemplateVars`. None of those can match a DLT approval: DLT does not
 * approve a template that is only a variable, one id cannot cover five wordings, and a payload
 * cannot know what was registered. Every one of them was a message MSG91 accepts and the
 * carrier drops -- recorded here as SENT.
 *
 * Now the wording comes from one registry (`templates/dlt-sms-templates.ts`), and a kind is
 * sent only when ALL of these hold, otherwise it is refused permanently with the exact key to
 * set:
 *   - the kind has registered wording in the registry;
 *   - a sender header is configured and is not one the portal rejected;
 *   - both its MSG91 template id and its 19-digit DLT template id are configured;
 *   - its variables are present and each fits DLT's 30-character limit.
 *
 * The sign-in code arrives already rendered (PhoneOtpService owns the code and never puts it
 * in a payload), so for that kind the body is matched against the registered wording and the
 * variables are read back out of it. A body that does not match is refused -- the carrier
 * would drop it -- and the error never contains the body, because the body is the code.
 *
 * ── ON THE REQUEST SHAPE ───────────────────────────────────────────────────────────
 * Written against MSG91's published v5 flow API. The route is the template's: a flow request
 * takes no route parameter, and a template added under the DLT transactional (service) route
 * is sent on it. The base URL and path are configurable because a vendor's API is not
 * something this repository can assert from the outside; verify against the account's own
 * documentation before enabling.
 */
export class Msg91SmsTransport implements SmsTransport {
  readonly name = 'msg91' as const;
  private readonly logger = new Logger('Notification');
  private readonly authKey: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly legacyTemplateIds: Record<string, string>;
  private readonly senderHeader?: string;
  private readonly config: ConfigService;
  /**
   * The canonical binding source, when one is wired.
   *
   * Optional because this transport is constructed directly in tests and by the legacy
   * single-provider factory, and neither has a Nest container to hand. Absent, the per-kind
   * keys and the legacy map are the whole answer.
   */
  private readonly bindings?: TemplateBindingService;

  constructor(config: ConfigService, bindings?: TemplateBindingService) {
    this.config = config;
    this.authKey = requireKey(config, 'msg91', 'MSG91_AUTH_KEY');
    const base = (config.get<string>('MSG91_BASE_URL') ?? 'https://control.msg91.com').replace(
      /\/+$/,
      '',
    );
    this.url = `${base}${config.get<string>('MSG91_SMS_PATH') ?? '/api/v5/flow'}`;
    this.timeoutMs = Number(config.get('MSG91_TIMEOUT_MS') ?? 10_000);
    this.legacyTemplateIds = parseTemplateIds(config.get<string>('MSG91_SMS_TEMPLATE_IDS'));
    this.bindings = bindings;
    /*
      The registered header, from configuration only. Startup refuses the two keys disagreeing,
      so either one is the same answer. There is deliberately no default: a header is granted
      to one legal entity, and the one this code once assumed (ETKTGO) was rejected.
    */
    this.senderHeader =
      (config.get<string>('DLT_SENDER_HEADER') || config.get<string>('MSG91_SENDER_ID'))?.trim() ||
      undefined;
  }

  async send(msg: RenderedNotification): Promise<DeliveryOutcome> {
    const to = resolveDestination(msg);
    if (!to) return noRecipient(msg, this.logger, this.name);

    /*
      The wording is chosen per reader, not only per type: a show-cancelled text for a buyer
      who paid cash must not speak of a refund. A replacement wording is used only once its own
      DLT id is set; until then the registered template is sent exactly as before, or, where
      its text is false for the reader, nothing is (see selectDltTemplate).
    */
    const selection = selectDltTemplate(msg.type, msg.payload, (key) =>
      this.config.get<string>(key),
    );
    if (!selection) {
      throw new TransportError(
        `${msg.type} has no registered DLT wording, so it cannot be sent by SMS in India. ` +
          `Register it in templates/dlt-sms-templates.ts and on the DLT portal first.`,
        this.name,
        FailureClass.TEMPLATE_NOT_FOUND,
      );
    }
    if ('refused' in selection) {
      throw new TransportError(selection.refused, this.name, FailureClass.TEMPLATE_NOT_FOUND);
    }
    const { template, replacement } = selection;

    if (!this.senderHeader) {
      throw new TransportError(
        'MSG91 has no sender header. Set DLT_SENDER_HEADER (and MSG91_SENDER_ID, the same ' +
          'value) to the header approved on the DLT portal.',
        this.name,
        FailureClass.CONFIGURATION_ERROR,
      );
    }
    if (REJECTED_SENDER_HEADERS.includes(this.senderHeader.toUpperCase())) {
      throw new TransportError(
        `Sender header ${this.senderHeader} was rejected on the DLT portal. Set the approved header.`,
        this.name,
        FailureClass.CONFIGURATION_ERROR,
      );
    }

    /*
      A replacement takes its MSG91 id from its own key only. The bindings and the legacy map
      are keyed by notification type, so for SHOW_CANCELLED they name the OLD template.
    */
    const templateId = replacement
      ? this.config.get<string>(template.msg91TemplateIdEnv)?.trim()
      : this.config.get<string>(template.msg91TemplateIdEnv)?.trim() ||
        this.bindings?.resolve({
          provider: this.name,
          channel: 'sms',
          type: msg.type,
          locale: msg.locale,
        })?.externalId ||
        this.legacyTemplateIds[msg.type];
    const dltTemplateId = this.config.get<string>(template.dltTemplateIdEnv)?.trim();
    if (!templateId || !dltTemplateId || !DLT_ID_PATTERN.test(dltTemplateId)) {
      /*
        Permanent on purpose. There is no template to retry with, and retrying over an hour
        would only delay the moment somebody notices the registration is incomplete. The
        message names the exact keys to set.
      */
      const missing = [
        ...(templateId ? [] : [template.msg91TemplateIdEnv]),
        ...(dltTemplateId && DLT_ID_PATTERN.test(dltTemplateId)
          ? []
          : [`${template.dltTemplateIdEnv} (19 digits)`]),
      ];
      throw new TransportError(
        `MSG91 has no approved DLT template bound for ${msg.type}. Set ${missing.join(' and ')}.`,
        this.name,
        FailureClass.TEMPLATE_NOT_FOUND,
      );
    }

    const values = this.variablesFor(template, msg);
    const recipient: Record<string, string> = { mobiles: to.replace(/^\+/, '') };
    template.variables.forEach((name, i) => {
      recipient[name] = values[i];
    });

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
        sender: this.senderHeader,
        short_url: '0',
        realTimeResponse: '1',
        // MSG91 wants the number without a leading '+'.
        recipients: [recipient],
      }),
    });

    /*
      MSG91 answers HTTP 200 for a refusal as well as an acceptance, distinguishing them in
      `type`. Treating 200 as success would record "sent" for messages the provider had just
      told us it would not carry. The provider's text is redacted: it can name the number.
    */
    if (data?.type && data.type !== 'success') {
      throw new TransportError(
        `MSG91 refused the message: ${redactProviderText(String(data.message ?? data.type)).slice(0, 300)}`,
        this.name,
        // The provider having considered the message and declined it -- their answer, not
        // our configuration.
        FailureClass.PERMANENT_REJECTION,
      );
    }
    const providerMessageId = typeof data?.message === 'string' ? data.message : null;
    /*
      The request id is logged because it is the only handle on a sign-in code's delivery: a
      code is never written to a Notification row, so its delivery report arrives with nothing
      to attach to, and this line is how support matches the two.
    */
    this.logger.log(
      `[sms:${msg.type}] msg91 accepted -> ${maskPhone(to)} request ${providerMessageId ?? 'n/a'}`,
    );
    return { provider: this.name, providerMessageId };
  }

  /** The template's variable values in order, or a permanent refusal naming what is wrong. */
  private variablesFor(template: DltSmsTemplate, msg: RenderedNotification): string[] {
    if (template.kind === OTP_SMS_KIND) {
      const values = matchDltSms(template, msg.body);
      if (!values) {
        /*
          Never the body in this message: the body is the code. Only that it differs, and
          where the wording comes from.
        */
        throw new TransportError(
          'The sign-in code text does not match the registered DLT wording. Unset ' +
            'OTP_SMS_TEMPLATE or make it identical to the ACCOUNT_SECURITY text in ' +
            'templates/dlt-sms-templates.ts.',
          this.name,
          FailureClass.CONFIGURATION_ERROR,
        );
      }
      return values;
    }
    const result = dltVariablesFromPayload(template, msg.payload);
    if ('missing' in result) {
      throw new TransportError(
        `${msg.type} is missing DLT variable(s): ${result.missing.join(', ')}. The registered ` +
          `wording cannot be sent with a blank in it.`,
        this.name,
        FailureClass.CONFIGURATION_ERROR,
      );
    }
    const tooLong = template.variables.filter(
      (_, i) => result.values[i].length > DLT_VARIABLE_MAX_LENGTH,
    );
    if (tooLong.length > 0) {
      throw new TransportError(
        `${msg.type} variable(s) ${tooLong.join(', ')} exceed the 30-character DLT limit.`,
        this.name,
        FailureClass.CONFIGURATION_ERROR,
      );
    }
    return result.values;
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
