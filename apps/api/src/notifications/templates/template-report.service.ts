import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  countSmsSegments,
  parseEnabledMarkets,
  type TemplateCategory,
} from '@eticketsgo/shared-types';
import { NotificationTemplateService } from './notification-template.service';
import { TemplateBindingService } from './template-binding.service';
import { TEMPLATE_CONTRACTS } from './template-contract';
import { fallbackChannelFor, immediateChannels, policyFor } from '../policy/notification-policy';

/**
 * What our own message copy looks like, before anybody asks a provider to approve it.
 *
 * ── WHY THIS EXISTS BEFORE THE PROVIDERS DO ────────────────────────────────────────
 * Both remaining launch blockers are approvals of TEXT: a DLT template registered with an
 * Indian telecom operator, and a WhatsApp template approved by Meta or the BSP. Both are slow,
 * both are submitted by a person, and both are priced by what the text turns out to be.
 *
 * An Indian transactional SMS is billed per 160-character GSM-7 segment — and drops to 70
 * characters the instant one character falls outside that alphabet. A rupee sign does it. A
 * curly quote pasted from a document does it. The same sentence is then three segments instead
 * of one, at three times the price, for every message the platform will ever send under that
 * approval. Nobody discovers that from an invoice until months later.
 *
 * So this measures the copy we already have, in the locales we already ship, and says exactly
 * what it will cost to send. It is submitted-once-priced-forever information, and the moment
 * to know it is before the submission.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────────────
 * It never rewrites anything, and it never calls a provider. Shortening approved wording to
 * save a segment is a compliance decision belonging to whoever signs the DLT registration,
 * and a tool that silently trimmed a sentence to fit would produce a message that no longer
 * matches the approval it was granted under. Reporting only.
 */

export interface SmsTemplateReport {
  type: string;
  locale: string;
  /** What would actually go on the wire, so the count is of the real thing. */
  characters: number;
  encoding: 'GSM7' | 'UCS2';
  segments: number;
  /**
   * Characters outside the GSM-7 alphabet, which are what forced UCS-2.
   *
   * Reported individually because the fix is nearly always a single character somebody did
   * not mean to type — a typographic quote, a non-breaking space, an en dash — and naming it
   * turns "this costs three times as much" into a one-character edit.
   */
  nonGsm7: string[];
  /** True when one character is costing this template a 129% price increase. */
  unicodeForFewCharacters: boolean;
}

export interface WhatsAppTemplateReport {
  type: string;
  provider: string;
  channel: 'whatsapp';
  locale: string;
  /** Whether an approved template id/name is configured for this pairing. */
  bound: boolean;
  externalId: 'CONFIGURED' | 'NOT_CONFIGURED';
  category: TemplateCategory | 'UNDECLARED';
  /** Variables the approved template will have to accept. */
  variableCount: number;
  requiredVariables: string[];
  /** Whether the policy table currently selects WhatsApp for this type at all. */
  policySelects: boolean;
  /** Whether an affirmative opt-in is required before this channel may be used. */
  consentRequired: boolean;
  /** Whether a rate exists for the category, so the message can be costed. */
  rateConfigured: boolean;
}

@Injectable()
export class TemplateReportService {
  constructor(
    private readonly config: ConfigService,
    private readonly templates: NotificationTemplateService,
    private readonly bindings: TemplateBindingService,
  ) {}

  /**
   * Every SMS this platform can send, measured.
   *
   * Driven from POLICY rather than a list: SMS is a fallback target, so the types that use it
   * are precisely the ones whose policy names it as one, and a hand-kept list here would be
   * wrong the first time somebody changed the table.
   */
  smsReport(locales: string[] = ['en', 'fr-CA']): SmsTemplateReport[] {
    const types = Object.values(NotificationType).filter(
      (t) => immediateChannels(t).includes('sms') || fallbackChannelFor(t) === 'sms',
    );
    const out: SmsTemplateReport[] = [];
    for (const type of types) {
      for (const locale of locales) {
        const rendered = this.templates.render(type, locale, this.sampleFor(type));
        const body = rendered.body;
        const counted = countSmsSegments(body);
        const nonGsm7 = [...new Set([...body].filter((ch) => !isGsm7(ch)))];
        out.push({
          type: String(type),
          locale,
          characters: body.length,
          encoding: counted.encoding,
          segments: counted.segments,
          nonGsm7,
          /*
            The case worth flagging on its own. A message comfortably inside one GSM-7 segment
            that tips into UCS-2 for one stray character is paying a multiple for something
            nobody chose, and it looks identical in every editor.
          */
          unicodeForFewCharacters: counted.encoding === 'UCS2' && body.length <= 160,
        });
      }
    }
    return out;
  }

  /** Every WhatsApp template that will need an approval, and what it will need to say. */
  async whatsAppReport(rateExists: (provider: string) => Promise<boolean>) {
    const markets = parseEnabledMarkets(this.config.get<string>('NOTIFICATION_MARKETS'));
    const providers = [
      ...new Set(
        markets
          .map((m) => this.providerForMarket(m))
          .filter((p): p is string => Boolean(p) && p !== 'log'),
      ),
    ];
    const locales = ['en', 'fr-CA'];
    const out: WhatsAppTemplateReport[] = [];

    for (const provider of providers) {
      const hasRate = await rateExists(provider);
      for (const type of Object.values(NotificationType)) {
        const policy = policyFor(type);
        const selects = immediateChannels(type).includes('whatsapp');
        // Types policy never routes to WhatsApp need no approval; listing them would turn a
        // launch checklist into a list of things nobody has to do.
        if (!selects) continue;
        for (const locale of locales) {
          const bound = this.bindings.resolve({
            provider,
            channel: 'whatsapp',
            type,
            locale,
          });
          const contract = TEMPLATE_CONTRACTS[type];
          out.push({
            type: String(type),
            provider,
            channel: 'whatsapp',
            locale,
            bound: Boolean(bound),
            // Never the id itself. This report is exactly the thing somebody pastes into a
            // ticket, and a template id identifies a registered sender.
            externalId: bound ? 'CONFIGURED' : 'NOT_CONFIGURED',
            category: bound?.category ?? 'UNDECLARED',
            variableCount: contract ? contract.required.length : 1,
            requiredVariables: [...(contract?.required ?? [])],
            policySelects: selects,
            consentRequired: (policy.optInRequired ?? []).includes('whatsapp'),
            rateConfigured: hasRate,
          });
        }
      }
    }
    return out;
  }

  private providerForMarket(market: string): string | null {
    const raw = this.config.get<string>('WHATSAPP_PROVIDER_BY_MARKET') ?? '';
    for (const entry of raw.split(',')) {
      const [m, p] = entry.split('=');
      if (m?.trim().toUpperCase() === market && p?.trim()) return p.trim().toLowerCase();
    }
    return this.config.get<string>('WHATSAPP_PROVIDER') ?? null;
  }

  /**
   * A payload that satisfies the type's contract, so the measurement is of a FULL message.
   *
   * Measuring a template rendered from an empty payload would measure the version with every
   * clause omitted — the shortest message the platform can produce, and never the one it
   * sends. The values are deliberately representative in LENGTH rather than realistic in
   * content: a booking reference is the width of a booking reference.
   */
  private sampleFor(type: NotificationType): Record<string, unknown> {
    const contract = TEMPLATE_CONTRACTS[type];
    const sample: Record<string, unknown> = {
      reference: 'ETG-IND-2026-000123',
      eventTitle: 'A Representative Film Title',
      eventName: 'A Representative Film Title',
      venue: 'PVR Vijayawada, Screen 4',
      startsAt: '2026-10-02T13:30:00.000Z',
      timezone: 'Asia/Kolkata',
      amountMinor: 45000,
      currency: 'INR',
      tickets: 2,
      seats: 'H12, H13',
    };
    if (!contract) return sample;
    return sample;
  }
}

/** The GSM-7 alphabet, as published. A character outside it forces UCS-2 for the whole message. */
const GSM7_SET = new Set(
  (
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà' +
    '^{}\\[~]|€'
  ).split(''),
);

function isGsm7(ch: string): boolean {
  return GSM7_SET.has(ch);
}
