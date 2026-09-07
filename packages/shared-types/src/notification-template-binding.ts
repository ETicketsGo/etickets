/**
 * The link between a notification type and the template a provider will actually carry.
 *
 * ── WHY A BINDING EXISTS AT ALL ────────────────────────────────────────────────────
 * Two of this platform's channels cannot send words. An Indian operator will only carry an
 * SMS whose exact wording was approved on a DLT portal and registered against a sender
 * header; WhatsApp will only carry a template approved by Meta or the BSP. So the message
 * this repository renders is not the message that goes out — it is the VARIABLES for a
 * message that lives in somebody else's console, identified by an id we are given.
 *
 * ── WHY THE OLD SHAPE WAS NOT ENOUGH ───────────────────────────────────────────────
 * There were two environment variables, `MSG91_SMS_TEMPLATE_IDS` and
 * `MSG91_WHATSAPP_TEMPLATES`, each mapping a notification type straight to an id. That works
 * exactly as long as there is one provider per channel and one language, and it silently
 * stops working at the first thing this platform has already committed to:
 *
 *   A Quebec customer must be written to in French. WhatsApp templates are approved PER
 *   LANGUAGE and have different ids, so one id per type cannot express it — and the failure
 *   is not an error, it is an English message sent to a French speaker.
 *
 *   Meta and MSG91 both carry WhatsApp, in different markets, with different template names
 *   for the same notification. One map per channel has nowhere to put the provider.
 *
 *   WhatsApp prices by CATEGORY — utility, authentication, marketing. The category is a
 *   property of the approved template, it is what the rate card is keyed by, and there was
 *   nowhere to record it, so every WhatsApp message was priced at whatever single rate
 *   somebody had entered.
 *
 * ── WHY IT IS CONFIGURATION AND NOT A TABLE IN CODE ────────────────────────────────
 * A template id is granted by a regulator or a vendor and can be revoked by them. Compiled
 * in, every approval becomes a deploy, and a wrong one is a message the API accepts and the
 * carrier silently drops. No id appears anywhere in this repository, and none ever should.
 */

/**
 * WhatsApp's pricing categories. Not ours — Meta's, and MSG91 resells the same three.
 * Recorded because the rate card is keyed by it and a utility message is not priced like a
 * marketing one.
 */
export type TemplateCategory = 'utility' | 'authentication' | 'marketing';

export interface TemplateBinding {
  provider: string;
  channel: string;
  /** The notification type, e.g. `SHOW_CANCELLED`. */
  type: string;
  /** A locale, or `*` for a binding that serves every language. */
  locale: string;
  /** The id or name the provider knows this template by. Never logged, never defaulted. */
  externalId: string;
  category?: TemplateCategory;
}

/** A binding key without the id, which is what a lookup asks for. */
export interface TemplateBindingQuery {
  provider: string;
  channel: string;
  type: string;
  /** The message's locale. `undefined` is treated as a request for the wildcard. */
  locale?: string | null;
}

const CATEGORIES: readonly string[] = ['utility', 'authentication', 'marketing'];

/**
 * Parse `provider:channel:TYPE:locale[:category]=externalId`, comma-separated.
 *
 * One variable rather than one per provider-and-channel, for the same reason the routing
 * table is one variable: a new provider is then an edit rather than a new configuration key,
 * and the whole binding set is visible in one value when somebody is working out why a
 * message was refused.
 *
 * Malformed entries are DROPPED rather than guessed at. A binding assembled out of a typo
 * would point at a template that does not exist, and the provider's refusal would arrive
 * hours later attached to a real customer's message. An absent binding fails immediately,
 * names the type, and is reported by readiness — which is the failure worth having.
 */
export function parseTemplateBindings(raw: string | null | undefined): TemplateBinding[] {
  const out: TemplateBinding[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const externalId = trimmed.slice(eq + 1).trim();
    if (!externalId) continue;

    const parts = key.split(':').map((p) => p.trim());
    if (parts.length < 4 || parts.length > 5) continue;
    const [provider, channel, type, locale, category] = parts;
    if (!provider || !channel || !type || !locale) continue;
    if (category && !CATEGORIES.includes(category.toLowerCase())) continue;

    out.push({
      provider: provider.toLowerCase(),
      channel: channel.toLowerCase(),
      // Notification types are upper snake case everywhere else; normalising here means a
      // lower-case entry in configuration still finds its binding.
      type: type.toUpperCase(),
      locale,
      externalId,
      category: category ? (category.toLowerCase() as TemplateCategory) : undefined,
    });
  }
  return out;
}

/**
 * Find the binding for one message.
 *
 * ── THE FALLBACK ORDER, AND WHY IT STOPS WHERE IT DOES ─────────────────────────────
 * Exact locale, then the base language, then the explicit wildcard. `fr-CA` finds a `fr-CA`
 * binding, else an `fr` one, else a `*` one — because an approval covering French generally
 * does cover Quebec, and a template declared for every language is a deliberate statement.
 *
 * It does NOT fall back to another locale's binding. Sending an English-approved template to
 * a French speaker is not a degraded success: it is the wrong language, delivered
 * confidently, with no error anywhere. Better to refuse and have readiness say which locale
 * is unbound.
 */
export function findTemplateBinding(
  bindings: readonly TemplateBinding[],
  query: TemplateBindingQuery,
): TemplateBinding | null {
  const provider = query.provider.toLowerCase();
  const channel = query.channel.toLowerCase();
  const type = query.type.toUpperCase();
  const candidates = bindings.filter(
    (b) => b.provider === provider && b.channel === channel && b.type === type,
  );
  if (candidates.length === 0) return null;

  const locale = (query.locale ?? '').trim();
  const base = locale.includes('-') ? locale.split('-')[0] : locale;
  const order = [locale, base, '*'].filter(Boolean);
  for (const want of order) {
    const hit = candidates.find((b) => b.locale.toLowerCase() === want.toLowerCase());
    if (hit) return hit;
  }
  return null;
}
