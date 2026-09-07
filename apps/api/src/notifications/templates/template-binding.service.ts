import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  findTemplateBinding,
  parseTemplateBindings,
  type TemplateBinding,
  type TemplateBindingQuery,
} from '@eticketsgo/shared-types';

/**
 * Where a provider's template id for a message comes from.
 *
 * ── WHY A SERVICE AND NOT A LOOKUP IN EACH TRANSPORT ───────────────────────────────
 * Both MSG91 transports parsed their own environment variable into their own map, and the
 * Meta transport had no concept of a template at all. Three answers to one question, none of
 * them able to say what the whole binding set looks like — which is exactly what the
 * readiness report and the WhatsApp template report need to ask.
 *
 * ── WHY THE OLD KEYS STILL WORK ────────────────────────────────────────────────────
 * `MSG91_SMS_TEMPLATE_IDS` and `MSG91_WHATSAPP_TEMPLATES` are documented in the setup guide
 * and may already be sitting in a deployment's variables. Dropping them would turn a
 * configured India into an unconfigured one at the exact moment somebody deploys this, and
 * the symptom — every SMS permanently refused — would look like a code defect. They are read
 * as a lower-priority source instead, and reported as legacy so they can be migrated
 * deliberately rather than discovered.
 */
@Injectable()
export class TemplateBindingService {
  constructor(private readonly config: ConfigService) {}

  /** Everything configured, canonical entries first. */
  all(): TemplateBinding[] {
    return [...this.canonical(), ...this.legacy()];
  }

  /** The canonical `NOTIFICATION_TEMPLATE_BINDINGS` entries. */
  private canonical(): TemplateBinding[] {
    return parseTemplateBindings(this.config.get<string>('NOTIFICATION_TEMPLATE_BINDINGS'));
  }

  /**
   * The pre-Phase-7 keys, read as `*`-locale bindings.
   *
   * `*` rather than `en` on purpose: that is what they meant. One id per type, used for
   * every message regardless of language, is precisely a wildcard binding — and calling it
   * `en` would make a French message fall through to nothing where today it sends.
   */
  private legacy(): TemplateBinding[] {
    const out: TemplateBinding[] = [];
    for (const [key, channel] of [
      ['MSG91_SMS_TEMPLATE_IDS', 'sms'],
      ['MSG91_WHATSAPP_TEMPLATES', 'whatsapp'],
    ] as const) {
      for (const entry of (this.config.get<string>(key) ?? '').split(',')) {
        const [type, id] = entry.split('=');
        if (!type?.trim() || !id?.trim()) continue;
        out.push({
          provider: 'msg91',
          channel,
          type: type.trim().toUpperCase(),
          locale: '*',
          externalId: id.trim(),
        });
      }
    }
    return out;
  }

  /**
   * The binding for one message, or null.
   *
   * Null is a complete answer and the caller must treat it as one. The transports turn it
   * into a permanent `TEMPLATE_NOT_FOUND` refusal rather than sending something — a message
   * sent under the wrong template id is accepted by the API and dropped by the carrier, which
   * is the failure that surfaces days later as "the customer never got their ticket".
   */
  resolve(query: TemplateBindingQuery): TemplateBinding | null {
    return findTemplateBinding(this.all(), query);
  }

  /**
   * Whether any binding at all exists for a provider and channel.
   *
   * Used by readiness to tell "nothing is bound" from "this one type is unbound", which are
   * a launch blocker and a gap respectively.
   */
  hasAnyFor(provider: string, channel: string): boolean {
    const p = provider.toLowerCase();
    const c = channel.toLowerCase();
    return this.all().some((b) => b.provider === p && b.channel === c);
  }

  /** Which of the canonical entries came from the superseded keys, for the readiness report. */
  legacyCount(): number {
    return this.legacy().length;
  }
}
