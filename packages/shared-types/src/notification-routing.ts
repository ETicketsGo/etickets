/**
 * Which messaging provider carries a notification, per market.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Every channel used to resolve exactly one provider, once, from one environment
 * variable — `SMS_PROVIDER=twilio` and that was the answer for the whole process. It is a
 * perfectly good answer for one market. It cannot express "India goes to MSG91 and the
 * United States goes to Twilio", which is not a preference but a requirement: an Indian
 * operator will not deliver a message that was not sent under a DLT-registered sender, and
 * Twilio's per-message price to India is not one we want to pay for transactional volume.
 *
 * So routing is a decision about the DESTINATION's market, and this file is where that
 * decision is made — once, purely, testably — instead of as a country conditional scattered
 * through the services that send things.
 *
 * ── WHY IT MIRRORS PAYMENT ROUTING ─────────────────────────────────────────────────
 * `routeProviderForBooking` in marketplace.ts already answers the same question for money:
 * a pure function over trusted server-side facts, returning null rather than guessing, with
 * lazy per-provider construction behind it. That pattern is proven here, so this copies its
 * shape rather than inventing a second one.
 *
 * ── WHY THE DESTINATION NUMBER IS THE AUTHORITY ────────────────────────────────────
 * For SMS and WhatsApp the market that matters is the one the message is being delivered
 * INTO, and the E.164 number is that fact — it is not a stored profile field that may
 * disagree with reality, and it is not anything a browser sent us. A caller may still pass a
 * country it knows from business data (a booking's venue, say), and that wins when present,
 * but the number is what is checked otherwise.
 */

/** Channels whose provider can differ by market. Email and push do not, today. */
export type RoutableChannel = 'sms' | 'whatsapp';

/** Why a route could not be chosen. Never "we picked something anyway". */
export type RouteRefusal = 'unknown_market' | 'unsupported_market' | 'ambiguous_market';

export type NotificationRoute =
  | { ok: true; provider: string; market: string | null }
  | { ok: false; refusal: RouteRefusal; market: string | null };

/**
 * ISO-3166 alpha-2 markets sharing each E.164 calling code, for the markets this platform
 * declares in `markets.ts`. Deliberately not a world list: a code that is not here resolves
 * to no market, which is refused rather than guessed.
 *
 * +1 is North America — the United States and Canada share it and a number cannot tell them
 * apart. That is fine when both route to the same provider, and honestly ambiguous when they
 * do not; see {@link routeNotificationProvider}.
 */
const CALLING_CODES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['971', ['AE']],
  ['91', ['IN']],
  ['65', ['SG']],
  ['64', ['NZ']],
  ['61', ['AU']],
  ['44', ['GB']],
  ['1', ['US', 'CA']],
];

/**
 * The market(s) an E.164 number could belong to, longest calling code first so +971 is not
 * read as +9. Returns an empty list for anything unrecognised or malformed.
 */
export function marketsForE164(phone: string | null | undefined): string[] {
  const digits = (phone ?? '').replace(/[^\d+]/g, '');
  if (!digits.startsWith('+')) return [];
  const national = digits.slice(1);
  for (const [code, markets] of CALLING_CODES) {
    if (national.startsWith(code)) return [...markets];
  }
  return [];
}

/**
 * Normalise whatever a caller has — 'IN', 'ind', 'India' — to an alpha-2 market code.
 * Stored country strings on this platform are inconsistent, which is exactly why payment
 * routing treats currency as authoritative and country as a check only.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  IN: 'IN',
  IND: 'IN',
  INDIA: 'IN',
  US: 'US',
  USA: 'US',
  'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US',
  CA: 'CA',
  CAN: 'CA',
  CANADA: 'CA',
  GB: 'GB',
  UK: 'GB',
  'UNITED KINGDOM': 'GB',
  AE: 'AE',
  'UNITED ARAB EMIRATES': 'AE',
  SG: 'SG',
  SINGAPORE: 'SG',
  AU: 'AU',
  AUSTRALIA: 'AU',
  NZ: 'NZ',
  'NEW ZEALAND': 'NZ',
};

export function normaliseMarket(country: string | null | undefined): string | null {
  const key = (country ?? '').trim().toUpperCase();
  if (!key) return null;
  return COUNTRY_ALIASES[key] ?? (/^[A-Z]{2}$/.test(key) ? key : null);
}

/**
 * Parse a market→provider map written as `IN=msg91,US=twilio,CA=twilio`.
 *
 * One environment variable per channel rather than one per market: adding a country is then
 * an edit, not a deploy of new configuration keys, and the whole routing table is visible in
 * a single value when somebody is trying to work out where a message went.
 */
export function parseMarketProviderMap(raw: string | null | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of (raw ?? '').split(',')) {
    const [rawMarket, rawProvider] = entry.split('=');
    const market = normaliseMarket(rawMarket);
    const provider = (rawProvider ?? '').trim().toLowerCase();
    if (market && provider) map[market] = provider;
  }
  return map;
}

export interface NotificationRouteContext {
  /** The market→provider table for this channel, from configuration. May be empty. */
  marketProviders: Record<string, string>;
  /**
   * The provider to use when no market table is configured at all. This is the existing
   * single-provider setting (`SMS_PROVIDER` / `WHATSAPP_PROVIDER`), which stays meaningful
   * for single-market and local/QA use.
   */
  defaultProvider: string;
  /** A market the caller knows from trusted business data. Wins over the number. */
  country?: string | null;
  /** The E.164 destination. Used to derive the market when `country` is absent. */
  destination?: string | null;
}

/**
 * Choose the provider for one message.
 *
 * ── WHAT IT REFUSES, AND WHY IT REFUSES RATHER THAN GUESSING ───────────────────────
 * Once a market table is configured, this platform is operating in more than one country,
 * and a destination it cannot attribute to a market is precisely the case where sending
 * anyway is a mistake: through the wrong provider it is either undeliverable (an Indian
 * operator dropping a non-DLT message) or expensive (international rates on a route that
 * was never priced for it). Neither failure is visible at the send — they surface as
 * customers who did not get their ticket.
 *
 * So an unknown or unsupported market is refused, and the notification is recorded FAILED
 * with the reason on it. When no market table is configured the platform is single-market
 * and the default provider is the whole answer, which is what local development and QA use.
 */
export function routeNotificationProvider(ctx: NotificationRouteContext): NotificationRoute {
  const configured = Object.keys(ctx.marketProviders).length > 0;
  if (!configured) return { ok: true, provider: ctx.defaultProvider, market: null };

  const declared = normaliseMarket(ctx.country);
  if (declared) {
    const provider = ctx.marketProviders[declared];
    return provider
      ? { ok: true, provider, market: declared }
      : { ok: false, refusal: 'unsupported_market', market: declared };
  }

  const candidates = marketsForE164(ctx.destination);
  if (candidates.length === 0) return { ok: false, refusal: 'unknown_market', market: null };

  /*
    +1 covers both the United States and Canada, and the number cannot say which. That only
    matters if the two are routed differently: when they agree — and in the launch matrix
    both go to Twilio — the answer is the same either way and there is nothing to disambiguate.
  */
  const providers = new Set(candidates.map((m) => ctx.marketProviders[m]));
  if (providers.size === 1) {
    const [only] = [...providers];
    return only
      ? { ok: true, provider: only, market: candidates.length === 1 ? candidates[0] : null }
      : { ok: false, refusal: 'unsupported_market', market: candidates[0] };
  }
  return { ok: false, refusal: 'ambiguous_market', market: null };
}

/**
 * The markets this platform is deliberately sending notifications into.
 *
 * -- WHY MARKET ENABLEMENT IS SEPARATE FROM PROVIDER ROUTING ------------------------
 * `SMS_PROVIDER_BY_MARKET` answers "who carries a message to India". It cannot answer "are
 * we launched in India", and the two were being conflated: readiness reported a hardcoded
 * IN/US/CA and marked the whole platform not-ready because Canada had no MSG91 templates --
 * for a Canada nobody had decided to launch. An operator reading that report cannot tell a
 * real blocker from a market that is not open yet, which makes the report worth ignoring.
 *
 * Enablement is therefore its own statement. A disabled market demands no credentials, no
 * templates and no rates, and contributes nothing to whether the platform is ready. An
 * enabled market must be completely configured, and says so loudly when it is not.
 *
 * -- WHY ONE LIST AND NOT ONE FLAG PER COUNTRY --------------------------------------
 * `NOTIFICATIONS_INDIA_ENABLED`, `NOTIFICATIONS_US_ENABLED` and so on would need a new
 * environment key, a new schema entry and a deploy for every country the platform ever
 * enters, and the full picture would never be visible in one value. The rest of this
 * subsystem already answers market questions with a comma list for exactly that reason.
 */
export function parseEnabledMarkets(
  raw: string | null | undefined,
  fallback: readonly string[] = ['IN', 'US', 'CA'],
): string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((entry) => normaliseMarket(entry))
    .filter((m): m is string => Boolean(m));
  /*
    An unset value keeps the markets this platform already reported on, so adding the key
    changes nothing by itself. An explicitly EMPTY value is a real answer -- "no market is
    open" -- and is honoured, because a deployment that runs migrations before launch needs
    to be able to say that without being handed three markets it never asked for.
  */
  if (raw === undefined || raw === null || raw.trim() === '') return [...fallback];
  return [...new Set(parsed)];
}
